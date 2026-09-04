import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { ScheduledJob, ScheduledJobSchedule } from "./gateway-store";
import type { ConversationAddress, Principal, TransportIdentity } from "./gateway-types";

const MAX_JOB_NAME_LENGTH = 120;
const MAX_JOB_PROMPT_LENGTH = 16_000;
const MAX_ERROR_LENGTH = 2_000;

export interface ScheduledJobContext {
  readonly principal: Principal;
  readonly identity: TransportIdentity;
  readonly address: ConversationAddress;
}

export interface CreateScheduledJobInput {
  readonly name: string;
  readonly prompt: string;
  readonly at?: string;
  readonly cron?: string;
  readonly timezone?: string;
}

export interface UpdateScheduledJobInput {
  readonly id: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly at?: string;
  readonly cron?: string;
  readonly timezone?: string;
}

export interface GatewayAutomationControl {
  create(input: CreateScheduledJobInput, context: ScheduledJobContext): ScheduledJob;
  update(input: UpdateScheduledJobInput, context: ScheduledJobContext): ScheduledJob;
  remove(id: string, principalId: string): boolean;
  setEnabled(id: string, principalId: string, enabled: boolean): ScheduledJob;
  runNow(id: string, principalId: string): ScheduledJob;
  get(id: string, principalId: string): ScheduledJob | undefined;
  list(principalId: string): readonly ScheduledJob[];
}

export interface GatewayScheduledJobStore {
  createScheduledJob(job: ScheduledJob): void;
  updateScheduledJob(job: ScheduledJob): boolean;
  getScheduledJob(id: string, principalId?: string): ScheduledJob | undefined;
  listScheduledJobs(principalId?: string): ScheduledJob[];
  listDueScheduledJobs(now: number, limit?: number): ScheduledJob[];
  deleteScheduledJob(id: string, principalId: string): boolean;
}

export type GatewaySchedulerTimer = NonNullable<Parameters<typeof clearTimeout>[0]>;

export interface GatewaySchedulerOptions {
  readonly store: GatewayScheduledJobStore;
  readonly dispatch: (job: ScheduledJob, scheduledFor: number) => Promise<void>;
  readonly enabled?: boolean;
  readonly pollIntervalMs?: number;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => GatewaySchedulerTimer;
  readonly clearTimer?: (timer: GatewaySchedulerTimer) => void;
  readonly onPermanentFailure?: (job: ScheduledJob, error: Error) => Promise<void> | void;
}

export interface GatewaySchedulerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** A scheduled turn waits for the existing interactive turn instead of counting as a failed attempt. */
export class ScheduledDispatchBusyError extends Error {
  readonly name = "ScheduledDispatchBusyError";
}

/** Durable one-shot and cron scheduling, scoped to server-derived gateway principals. */
export class GatewayScheduler implements GatewayAutomationControl {
  readonly #options: Required<Pick<GatewaySchedulerOptions, "pollIntervalMs" | "retryDelayMs" | "maxAttempts">> &
    GatewaySchedulerOptions;
  readonly #log: GatewaySchedulerLogger;
  readonly #setTimer: (callback: () => void, delayMs: number) => GatewaySchedulerTimer;
  readonly #clearTimer: (timer: GatewaySchedulerTimer) => void;
  #timer: GatewaySchedulerTimer | undefined;
  #started = false;
  #running = false;

  constructor(options: GatewaySchedulerOptions, logger: GatewaySchedulerLogger = console) {
    this.#options = {
      ...options,
      pollIntervalMs: boundedInteger(options.pollIntervalMs ?? 1_000, "scheduler poll interval", 250, 60_000),
      retryDelayMs: boundedInteger(options.retryDelayMs ?? 15_000, "scheduler retry delay", 1_000, 3_600_000),
      maxAttempts: boundedInteger(options.maxAttempts ?? 3, "scheduler max attempts", 1, 10),
    };
    this.#log = logger;
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }
  start(): void {
    if (this.#started || this.#options.enabled === false) return;
    this.#started = true;
    this.#schedule(0);
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }

  create(input: CreateScheduledJobInput, context: ScheduledJobContext): ScheduledJob {
    validateContext(context);
    const now = this.#now();
    const schedule = parseSchedule(input, now);
    const nextRunAt = nextOccurrence(schedule, now - 1);
    if (nextRunAt === undefined) throw new Error("Schedule has no future occurrence");
    const job: ScheduledJob = {
      id: randomUUID(),
      principalId: context.principal.id,
      identity: context.identity,
      address: context.address,
      name: boundedText(input.name, "job name", MAX_JOB_NAME_LENGTH),
      prompt: boundedText(input.prompt, "job prompt", MAX_JOB_PROMPT_LENGTH),
      schedule,
      enabled: true,
      nextRunAt,
      attemptCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.#options.store.createScheduledJob(job);
    this.#wake();
    return job;
  }

  update(input: UpdateScheduledJobInput, context: ScheduledJobContext): ScheduledJob {
    validateContext(context);
    const id = boundedText(input.id, "job id", 128);
    const current = this.#owned(id, context.principal.id);
    const now = this.#now();
    const replacesSchedule = input.at !== undefined || input.cron !== undefined;
    const changesSchedule = replacesSchedule || input.timezone !== undefined;
    const schedule = replacesSchedule
      ? parseSchedule(input, now)
      : input.timezone === undefined
        ? current.schedule
        : current.schedule.kind === "cron"
          ? parseSchedule({ cron: current.schedule.expression, timezone: input.timezone }, now)
          : (() => {
              throw new Error("timezone is only valid with cron");
            })();
    const nextRunAt = changesSchedule ? nextOccurrence(schedule, now - 1) : current.nextRunAt;
    if (changesSchedule && nextRunAt === undefined) throw new Error("Schedule has no future occurrence");
    const updated: ScheduledJob = {
      ...current,
      identity: context.identity,
      address: context.address,
      name: input.name === undefined ? current.name : boundedText(input.name, "job name", MAX_JOB_NAME_LENGTH),
      prompt:
        input.prompt === undefined ? current.prompt : boundedText(input.prompt, "job prompt", MAX_JOB_PROMPT_LENGTH),
      schedule,
      enabled: changesSchedule ? true : current.enabled,
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
      retryAt: undefined,
      attemptCount: 0,
      updatedAt: now,
    };
    if (!this.#options.store.updateScheduledJob(updated)) throw new Error(`Scheduled job ${id} no longer exists`);
    this.#wake();
    return updated;
  }

  remove(id: string, principalId: string): boolean {
    const removed = this.#options.store.deleteScheduledJob(
      boundedText(id, "job id", 128),
      boundedText(principalId, "principal id", 256),
    );
    this.#wake();
    return removed;
  }

  setEnabled(id: string, principalId: string, enabled: boolean): ScheduledJob {
    const current = this.#owned(id, principalId);
    const now = this.#now();
    const nextRunAt = enabled ? nextOccurrence(current.schedule, now - 1) : current.nextRunAt;
    if (enabled && nextRunAt === undefined)
      throw new Error("One-shot job has already expired; update its schedule before enabling it");
    const updated: ScheduledJob = {
      ...current,
      enabled,
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
      retryAt: undefined,
      attemptCount: 0,
      updatedAt: now,
    };
    if (!this.#options.store.updateScheduledJob(updated))
      throw new Error(`Scheduled job ${current.id} no longer exists`);
    this.#wake();
    return updated;
  }

  runNow(id: string, principalId: string): ScheduledJob {
    const current = this.#owned(id, principalId);
    const now = this.#now();
    const updated: ScheduledJob = {
      ...current,
      enabled: true,
      nextRunAt: now,
      retryAt: undefined,
      attemptCount: 0,
      updatedAt: now,
    };
    if (!this.#options.store.updateScheduledJob(updated))
      throw new Error(`Scheduled job ${current.id} no longer exists`);
    this.#wake();
    return updated;
  }

  get(id: string, principalId: string): ScheduledJob | undefined {
    return this.#options.store.getScheduledJob(
      boundedText(id, "job id", 128),
      boundedText(principalId, "principal id", 256),
    );
  }

  list(principalId: string): readonly ScheduledJob[] {
    return this.#options.store.listScheduledJobs(boundedText(principalId, "principal id", 256));
  }

  /** Execute all currently due jobs. Public for deterministic service smoke tests. */
  async runDue(now = this.#now()): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    let executed = 0;
    try {
      for (const due of this.#options.store.listDueScheduledJobs(now)) {
        const job = this.#options.store.getScheduledJob(due.id);
        if (job === undefined || !job.enabled || job.nextRunAt === undefined) continue;
        const dueAt = job.retryAt ?? job.nextRunAt;
        if (dueAt > now) continue;
        try {
          await this.#options.dispatch(job, job.nextRunAt);
          this.#recordSuccess(job, now);
          executed += 1;
        } catch (error) {
          if (error instanceof ScheduledDispatchBusyError) {
            this.#recordBusy(job, now);
            continue;
          }
          await this.#recordFailure(job, error, now);
        }
      }
    } finally {
      this.#running = false;
    }
    return executed;
  }

  #recordSuccess(job: ScheduledJob, now: number): void {
    const nextRunAt = job.schedule.kind === "cron" ? nextOccurrence(job.schedule, now) : undefined;
    const updated: ScheduledJob = {
      ...job,
      enabled: nextRunAt !== undefined,
      ...(nextRunAt === undefined ? { nextRunAt: undefined } : { nextRunAt }),
      retryAt: undefined,
      attemptCount: 0,
      successCount: job.successCount + 1,
      updatedAt: now,
      lastRunAt: now,
      lastSuccessAt: now,
      lastError: undefined,
    };
    this.#options.store.updateScheduledJob(updated);
    this.#log.info(`Scheduled job ${job.id} completed`);
  }

  #recordBusy(job: ScheduledJob, now: number): void {
    this.#options.store.updateScheduledJob({
      ...job,
      retryAt: now + Math.min(this.#options.pollIntervalMs, 5_000),
      updatedAt: now,
    });
  }

  async #recordFailure(job: ScheduledJob, thrown: unknown, now: number): Promise<void> {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    const attemptCount = job.attemptCount + 1;
    const message = error.message.slice(0, MAX_ERROR_LENGTH);
    if (attemptCount < this.#options.maxAttempts) {
      this.#options.store.updateScheduledJob({
        ...job,
        retryAt: now + this.#options.retryDelayMs * attemptCount,
        attemptCount,
        updatedAt: now,
        lastRunAt: now,
        lastError: message,
      });
      this.#log.warn(`Scheduled job ${job.id} attempt ${attemptCount} failed: ${message}`);
      return;
    }

    const nextRunAt = job.schedule.kind === "cron" ? nextOccurrence(job.schedule, now) : undefined;
    const failed: ScheduledJob = {
      ...job,
      enabled: nextRunAt !== undefined,
      ...(nextRunAt === undefined ? { nextRunAt: undefined } : { nextRunAt }),
      retryAt: undefined,
      attemptCount: 0,
      failureCount: job.failureCount + 1,
      updatedAt: now,
      lastRunAt: now,
      lastError: message,
    };
    this.#options.store.updateScheduledJob(failed);
    this.#log.error(`Scheduled job ${job.id} exhausted ${this.#options.maxAttempts} attempts: ${message}`);
    try {
      await this.#options.onPermanentFailure?.(failed, error);
    } catch (notifyError) {
      this.#log.warn(`Could not deliver scheduled job failure notice: ${String(notifyError)}`);
    }
  }

  #owned(id: string, principalId: string): ScheduledJob {
    const jobId = boundedText(id, "job id", 128);
    const owner = boundedText(principalId, "principal id", 256);
    const job = this.#options.store.getScheduledJob(jobId, owner);
    if (job === undefined) throw new Error(`Scheduled job ${jobId} was not found`);
    return job;
  }

  #now(): number {
    const now = (this.#options.now ?? Date.now)();
    if (!Number.isSafeInteger(now)) throw new Error("Scheduler clock must return an integer timestamp");
    return now;
  }

  #wake(): void {
    if (!this.#started) return;
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#schedule(0);
  }

  #schedule(delayMs: number): void {
    if (!this.#started) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      void this.runDue()
        .catch((error) => this.#log.error(`Scheduled job poll failed: ${String(error)}`))
        .finally(() => {
          this.#schedule(this.#options.pollIntervalMs);
        });
    }, delayMs);
  }
}

export function friendlyTimezoneName(timezone?: string, date = new Date()): string | undefined {
  if (!timezone) return undefined;
  if (timezone === "UTC" || timezone === "Etc/UTC") return "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longGeneric" }).formatToParts(
      date,
    );
    const name = parts.find((part) => part.type === "timeZoneName")?.value;
    if (name) {
      return name.replace(/ (?:Standard |Daylight )?Time$/, "").trim() || name;
    }
  } catch {
    // fallback on error
  }
  return timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone;
}

export function humanizeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [min, hour, dom, mon, dow] = parts;
  if (min === undefined || hour === undefined || dom === undefined || mon === undefined || dow === undefined) {
    return expression;
  }

  const isInt = (value: string): boolean => /^\d+$/.test(value);

  if (/^\*\/\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const step = Number.parseInt(min.slice(2), 10);
    return step === 1 ? "Every minute" : `Every ${step} minutes`;
  }

  if (min === "0" && (/^\*\/\d+$/.test(hour) || hour === "*") && dom === "*" && mon === "*" && dow === "*") {
    if (hour === "*") return "Every hour";
    const step = Number.parseInt(hour.slice(2), 10);
    return step === 1 ? "Every hour" : `Every ${step} hours`;
  }

  const formatTime = (hStr: string, mStr: string): string | null => {
    const hNum = Number.parseInt(hStr, 10);
    const mNum = Number.parseInt(mStr, 10);
    if (hNum < 0 || hNum > 23 || mNum < 0 || mNum > 59) return null;
    const period = hNum >= 12 ? "PM" : "AM";
    const h12 = hNum % 12 === 0 ? 12 : hNum % 12;
    const minuteFormatted = mNum.toString().padStart(2, "0");
    return `${h12}:${minuteFormatted} ${period}`;
  };

  const dayNames: Readonly<Record<string, string>> = {
    "0": "Sunday",
    "7": "Sunday",
    sun: "Sunday",
    "1": "Monday",
    mon: "Monday",
    "2": "Tuesday",
    tue: "Tuesday",
    "3": "Wednesday",
    wed: "Wednesday",
    "4": "Thursday",
    thu: "Thursday",
    "5": "Friday",
    fri: "Friday",
    "6": "Saturday",
    sat: "Saturday",
  };

  if (isInt(min) && isInt(hour) && dom === "*" && mon === "*") {
    const time = formatTime(hour, min);
    if (!time) return expression;

    if (dow === "*") return `Every day at ${time}`;

    const dowLower = dow.toLowerCase();
    if (dowLower === "1-5" || dowLower === "mon-fri") return `Every weekday at ${time}`;
    if (dowLower === "0,6" || dowLower === "6,0" || dowLower === "sat,sun" || dowLower === "sun,sat") {
      return `Every weekend at ${time}`;
    }
    const day = dayNames[dowLower];
    if (day !== undefined) return `Every ${day} at ${time}`;
  }

  return expression;
}

function safeFormat(options: Intl.DateTimeFormatOptions, timezone?: string): Intl.DateTimeFormat {
  if (timezone) {
    try {
      return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone });
    } catch {
      // ignore invalid timezone
    }
  }
  return new Intl.DateTimeFormat("en-US", options);
}

export function formatHumanSchedule(schedule: ScheduledJobSchedule): string {
  if (schedule.kind === "at") {
    const date = new Date(schedule.at);
    const tz = friendlyTimezoneName(undefined, date);
    const tzSuffix = tz ? ` ${tz}` : "";
    const dateFormatted = safeFormat({
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date);
    return `Once at ${dateFormatted}${tzSuffix}`;
  }
  const cronText = humanizeCron(schedule.expression);
  const tz = friendlyTimezoneName(schedule.timezone);
  return tz ? `${cronText} (${tz})` : cronText;
}

export function formatFriendlyNextRun(
  nextRunAt: number | undefined,
  now: number = Date.now(),
  timezone?: string,
  enabled = true,
): string {
  if (nextRunAt === undefined) return enabled === false ? "Paused" : "None scheduled";
  const diffMs = nextRunAt - now;
  const targetDate = new Date(nextRunAt);
  const tz = friendlyTimezoneName(timezone, targetDate);
  const tzSuffix = tz ? ` ${tz}` : "";

  if (diffMs < 0) return "Past due";
  if (diffMs < 60_000) return "in < 1 min";
  if (diffMs < 60 * 60_000) {
    const mins = Math.max(1, Math.round(diffMs / 60_000));
    return `in ${mins} min`;
  }

  let nowDateStr: string;
  let targetDateStr: string;
  let timeStr: string;
  try {
    const caFmt = timezone
      ? new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
      : new Intl.DateTimeFormat("en-CA");
    nowDateStr = caFmt.format(new Date(now));
    targetDateStr = caFmt.format(targetDate);
    const timeFmt = safeFormat({ hour: "numeric", minute: "2-digit", hour12: true }, timezone);
    timeStr = timeFmt.format(targetDate);
  } catch {
    nowDateStr = new Date(now).toISOString().slice(0, 10);
    targetDateStr = targetDate.toISOString().slice(0, 10);
    timeStr = targetDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }

  const nowDay = new Date(`${nowDateStr}T00:00:00Z`).getTime();
  const targetDay = new Date(`${targetDateStr}T00:00:00Z`).getTime();
  const dayDiff = Math.round((targetDay - nowDay) / 86_400_000);

  if (dayDiff === 0) return `Today at ${timeStr}${tzSuffix}`;
  if (dayDiff === 1) return `Tomorrow at ${timeStr}${tzSuffix}`;
  if (dayDiff > 1 && dayDiff < 7) {
    const weekdayFmt = safeFormat({ weekday: "long" }, timezone);
    return `${weekdayFmt.format(targetDate)} at ${timeStr}${tzSuffix}`;
  }
  const dateFmt = safeFormat({ month: "short", day: "numeric" }, timezone);
  return `${dateFmt.format(targetDate)} at ${timeStr}${tzSuffix}`;
}

export function formatScheduledJob(job: ScheduledJob, now: number = Date.now()): string {
  const schedule = formatHumanSchedule(job.schedule);
  const timezone = job.schedule.kind === "cron" ? job.schedule.timezone : undefined;
  const next = formatFriendlyNextRun(job.retryAt ?? job.nextRunAt, now, timezone, job.enabled);
  const result = job.lastError === undefined ? "never failed" : `last error: ${job.lastError}`;
  return `${job.enabled ? "enabled" : "disabled"} | ${job.name} | id ${job.id} | ${schedule} | next ${next} | ${job.successCount} succeeded, ${job.failureCount} failed | ${result}`;
}

function parseSchedule(
  input: Pick<CreateScheduledJobInput, "at" | "cron" | "timezone">,
  now: number,
): ScheduledJobSchedule {
  if ((input.at === undefined) === (input.cron === undefined)) {
    throw new Error("Specify exactly one of at or cron");
  }
  if (input.at !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at)) {
      throw new Error("job time must be an ISO 8601 date-time with an explicit UTC offset");
    }
    if (input.timezone !== undefined) throw new Error("timezone is only valid with cron");
    const parsed = Date.parse(boundedText(input.at, "job time", 256));
    if (!Number.isSafeInteger(parsed)) throw new Error("job time must be an ISO 8601 date-time");
    return { kind: "at", at: parsed };
  }

  const expression = boundedText(input.cron, "cron expression", 256);
  const timezone = input.timezone === undefined ? undefined : boundedText(input.timezone, "cron timezone", 128);
  if (timezone !== undefined) validateTimezone(timezone);
  const schedule: ScheduledJobSchedule = { kind: "cron", expression, ...(timezone === undefined ? {} : { timezone }) };
  try {
    if (nextOccurrence(schedule, now - 1) === undefined) throw new Error("no future occurrence");
  } catch (error) {
    throw new Error(`Invalid cron schedule: ${error instanceof Error ? error.message : String(error)}`);
  }
  return schedule;
}

function nextOccurrence(schedule: ScheduledJobSchedule, after: number): number | undefined {
  if (schedule.kind === "at") return schedule.at >= after ? schedule.at : undefined;
  const cron = new Cron(schedule.expression, {
    paused: true,
    ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
  });
  const next = cron.nextRun(new Date(after));
  return next?.getTime();
}

function validateContext(context: ScheduledJobContext): void {
  boundedText(context.principal.id, "principal id", 256);
  for (const role of context.principal.roles) boundedText(role, "principal role", 128);
  boundedText(context.identity.transport, "identity transport", 128);
  boundedText(context.identity.account, "identity account", 128);
  boundedText(context.identity.subject, "identity subject", 256);
  boundedText(context.address.transport, "address transport", 128);
  boundedText(context.address.account, "address account", 128);
  boundedText(context.address.channel, "address channel", 256);
  if (context.address.thread !== undefined) boundedText(context.address.thread, "address thread", 256);
  if (
    context.identity.transport !== context.address.transport ||
    context.identity.account !== context.address.account
  ) {
    throw new Error("Scheduled job identity and address must use the same transport account");
  }
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid IANA timezone ${timezone}`);
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
