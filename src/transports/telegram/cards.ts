export interface TelegramCardButton {
  readonly text: string;
  readonly action: string;
}

export interface TelegramCardRender {
  readonly text: string;
  readonly inlineKeyboard: readonly (readonly TelegramCardButton[])[];
}

export type PairingJourneyCardState = "pending" | "connected" | "examples" | "rejected" | "expired";

export interface PairingJourneyCard {
  readonly state: PairingJourneyCardState;
  readonly code?: string;
  readonly expiresIn?: string;
}

function pairingJourneyText(card: PairingJourneyCard): string {
  if (card.state === "connected") {
    return [
      "✅ Connected",
      "You can send messages, voice notes, photos, and files to the OMP agent; it can help with each in this chat.",
    ].join("\n\n");
  }
  if (card.state === "examples") {
    return [
      "✅ Connected",
      "You can send messages, voice notes, photos, and files to the OMP agent; it can help with each in this chat.",
      "Examples",
      "/home — open the control center\n/status — show session and runtime details\n/tasks — show recent tasks\nSend a photo, voice note, or file with an instruction.",
    ].join("\n\n");
  }
  if (card.state === "rejected") {
    return [
      "Pairing request rejected",
      "The gateway operator did not authorize this Telegram account. You can request a new pairing code.",
    ].join("\n\n");
  }
  if (card.state === "expired") {
    return ["Pairing request expired", "This pairing code is no longer valid. You can request a new one."].join("\n\n");
  }
  return [
    "Welcome to OmpClaw",
    "This bot is connected to an OMP agent, but this Telegram account is not authorized yet.",
    "Pairing request: sent",
    ...(card.code === undefined ? [] : [`Pairing code: ${card.code}`]),
    ...(card.expiresIn === undefined ? [] : [`Expires in ${card.expiresIn}.`]),
    "The gateway operator must approve this request. This message updates automatically.",
  ].join("\n\n");
}

/** Renders the durable first-run pairing journey in one mutable message. */
export function renderPairingJourneyCard(
  card: PairingJourneyCard,
  callback: (action: string) => string,
): TelegramCardRender {
  const inlineKeyboard: TelegramCardButton[][] =
    card.state === "connected"
      ? [
          [
            { text: "Open Home", action: callback("home") },
            { text: "See examples", action: callback("examples") },
          ],
        ]
      : card.state === "examples"
        ? [[{ text: "Dismiss", action: callback("dismiss") }]]
        : card.state === "rejected" || card.state === "expired"
          ? [[{ text: "Retry pairing", action: callback("retry") }]]
          : [];
  return { text: pairingJourneyText(card), inlineKeyboard };
}

export interface PickerCardOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly selected?: boolean;
  readonly disabled?: boolean;
}

export interface PickerCard {
  readonly title: string;
  readonly current?: string;
  readonly prompt: string;
  readonly options: readonly PickerCardOption[];
  readonly page: number;
  readonly pageCount: number;
  readonly warning?: string;
  readonly backAction?: string;
  readonly doneAction?: string;
  readonly cancelAction?: string;
}

export type DecisionCardState = "active" | "waiting_answer" | "approved" | "denied" | "expired";

export interface DecisionCardChoice {
  readonly id: string;
  readonly label: string;
  readonly shortLabel?: string;
  readonly disabled?: boolean;
}

export interface DecisionCard {
  readonly title: string;
  readonly preview: string;
  readonly choices: readonly DecisionCardChoice[];
  readonly expiresAt?: number;
  readonly state: DecisionCardState;
  readonly settledLabel?: string;
  readonly askAgainAction?: string;
  readonly cancelTaskAction?: string;
}

function boundedButtonText(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 63).trimEnd()}…`;
}

function pickerText(card: PickerCard): string {
  const optionDetails = card.options.flatMap((option) =>
    option.description === undefined ? [] : [`${option.selected ? "✓ " : ""}${option.label}\n${option.description}`],
  );
  return [
    card.title,
    card.current === undefined ? undefined : `Current: ${card.current}`,
    card.prompt,
    card.warning === undefined ? undefined : `⚠️ ${card.warning}`,
    ...optionDetails,
  ]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join("\n\n");
}

/** Renders one picker surface; navigation callbacks remain owned by its caller. */
export function renderPickerCard(card: PickerCard, callback: (action: string) => string): TelegramCardRender {
  const rows: TelegramCardButton[][] = card.options.map((option) => [
    {
      text: boundedButtonText(`${option.selected ? "✓ " : ""}${option.label}`),
      action: callback(option.disabled === true ? "noop" : `pick-${option.id}`),
    },
  ]);
  if (card.pageCount > 1) {
    rows.push([
      { text: "← Prev", action: callback(card.page === 0 ? "noop" : "previous") },
      { text: `${card.page + 1} / ${card.pageCount}`, action: callback("noop") },
      { text: "Next →", action: callback(card.page + 1 >= card.pageCount ? "noop" : "next") },
    ]);
  }
  const footer: TelegramCardButton[] = [];
  if (card.backAction !== undefined) footer.push({ text: "← Back", action: callback(card.backAction) });
  if (card.doneAction !== undefined) footer.push({ text: "Done", action: callback(card.doneAction) });
  if (card.cancelAction !== undefined) footer.push({ text: "Cancel", action: callback(card.cancelAction) });
  if (footer.length > 0) rows.push(footer);
  return { text: pickerText(card), inlineKeyboard: rows };
}

function decisionStateText(card: DecisionCard): string | undefined {
  if (card.state === "approved") return card.settledLabel ?? "✅ Approved";
  if (card.state === "denied") return card.settledLabel ?? "🚫 Denied";
  if (card.state === "expired") return card.settledLabel ?? "⌛ Expired — the agent is still waiting";
  if (card.state === "waiting_answer") return "⌛ Waiting for your answer\nReply to this card with your answer.";
  return undefined;
}

function decisionText(card: DecisionCard): string {
  const choiceText =
    card.choices.length === 0
      ? []
      : ["Choices", ...card.choices.map((choice, index) => `${index + 1}. ${choice.label}`)];
  const expiry = card.expiresAt === undefined ? undefined : `Expires at ${new Date(card.expiresAt).toISOString()}`;
  return [card.title, card.preview, ...choiceText, expiry, decisionStateText(card)]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join("\n\n");
}

/** Renders a decision in its active, waiting, or terminal in-message form. */
export function renderDecisionCard(card: DecisionCard, callback: (action: string) => string): TelegramCardRender {
  const rows: TelegramCardButton[][] = [];
  if (card.state === "active") {
    for (const choice of card.choices) {
      rows.push([
        {
          text: boundedButtonText(choice.shortLabel ?? choice.label),
          action: callback(choice.disabled === true ? "noop" : choice.id),
        },
      ]);
    }
    if (card.choices.length > 0) rows.push([{ text: "Other answer", action: callback("other") }]);
  }
  if (
    (card.state === "approved" || card.state === "denied" || card.state === "expired") &&
    card.askAgainAction !== undefined
  ) {
    const footer: TelegramCardButton[] = [{ text: "Ask again", action: callback(card.askAgainAction) }];
    if (card.cancelTaskAction !== undefined)
      footer.push({ text: "Cancel task", action: callback(card.cancelTaskAction) });
    rows.push(footer);
  }
  return { text: decisionText(card), inlineKeyboard: rows };
}
