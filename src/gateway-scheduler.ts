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

export type GatewaySchedulerTimer = ReturnType<typeof setTimeout> | number;

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
  readonly #options: Required<Pick<GatewaySchedulerOptions, "pollIntervalMs" | "retryDelayMs" | "maxAttempts">> & GatewaySchedulerOptions;
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
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as never));
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
          : (() => { throw new Error("timezone is only valid with cron"); })();
    const nextRunAt = changesSchedule ? nextOccurrence(schedule, now - 1) : current.nextRunAt;
    if (changesSchedule && nextRunAt === undefined) throw new Error("Schedule has no future occurrence");
    const updated: ScheduledJob = {
      ...current,
      identity: context.identity,
      address: context.address,
      name: input.name === undefined ? current.name : boundedText(input.name, "job name", MAX_JOB_NAME_LENGTH),
      prompt: input.prompt === undefined ? current.prompt : boundedText(input.prompt, "job prompt", MAX_JOB_PROMPT_LENGTH),
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
    if (enabled && nextRunAt === undefined) throw new Error("One-shot job has already expired; update its schedule before enabling it");
    const updated: ScheduledJob = {
      ...current,
      enabled,
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
      retryAt: undefined,
      attemptCount: 0,
      updatedAt: now,
    };
    if (!this.#options.store.updateScheduledJob(updated)) throw new Error(`Scheduled job ${current.id} no longer exists`);
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
    if (!this.#options.store.updateScheduledJob(updated)) throw new Error(`Scheduled job ${current.id} no longer exists`);
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
      void this.runDue().catch((error) => this.#log.error(`Scheduled job poll failed: ${String(error)}`)).finally(() => {
        this.#schedule(this.#options.pollIntervalMs);
      });
    }, delayMs);
  }
}

export function formatScheduledJob(job: ScheduledJob): string {
  const schedule = job.schedule.kind === "at"
    ? `once at ${new Date(job.schedule.at).toISOString()}`
    : `cron ${job.schedule.expression}${job.schedule.timezone === undefined ? "" : ` (${job.schedule.timezone})`}`;
  const next = job.nextRunAt === undefined ? "none" : new Date(job.retryAt ?? job.nextRunAt).toISOString();
  const result = job.lastError === undefined ? "never failed" : `last error: ${job.lastError}`;
  return `${job.enabled ? "enabled" : "disabled"} | ${job.name} | id ${job.id} | ${schedule} | next ${next} | ${job.successCount} succeeded, ${job.failureCount} failed | ${result}`;
}

function parseSchedule(input: Pick<CreateScheduledJobInput, "at" | "cron" | "timezone">, now: number): ScheduledJobSchedule {
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
  if (context.identity.transport !== context.address.transport || context.identity.account !== context.address.account) {
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
