export interface TransportIdentity {
  readonly transport: string;
  readonly account: string;
  readonly subject: string;
}

export interface Principal {
  readonly id: string;
  readonly roles: readonly string[];
}

export interface ConversationAddress {
  readonly transport: string;
  readonly account: string;
  readonly channel: string;
  readonly thread?: string;
}
export interface DeliveryContext {
  readonly principal: Principal;
  readonly origin: ConversationAddress;
}

export interface MessageAttachment {
  readonly url: string;
  readonly name?: string;
  readonly mediaType?: string;
}

export interface InboundContent {
  readonly text?: string;
  readonly attachments?: readonly MessageAttachment[];
}

/**
 * Reply data supplied by the transport. It is untrusted message content, not
 * authenticated metadata about the sender.
 */
export interface InboundReplyContext {
  readonly messageId: string;
  readonly author?: string;
  readonly text?: string;
  readonly isBot?: boolean;
}

export interface InboundCompositionHint {
  readonly kind: "text" | "media";
  readonly groupId?: string;
  readonly order: number;
}

/**
 * Transport-provided data. A principal is deliberately absent: it is derived by
 * the gateway from identity before any inbound handler can observe the message.
 */
export interface InboundEnvelope {
  readonly id: string;
  readonly sentAt: number;
  readonly identity: TransportIdentity;
  readonly address: ConversationAddress;
  readonly content: InboundContent;
  readonly replyTo?: OutboundReceipt;
  readonly replyContext?: InboundReplyContext;
  readonly composition?: InboundCompositionHint;
  /** Receipt for the inbound message itself, used only for same-origin reactions and replies. */
  readonly sourceReceipt?: OutboundReceipt;
  readonly edited?: boolean;
}

export interface InboundMessage extends InboundEnvelope {
  readonly principal: Principal;
}

export type OutboundNotification = "default" | "silent";

export interface OutboundContent {
  readonly text?: string;
  readonly attachments?: readonly MessageAttachment[];
  readonly replyTo?: OutboundReceipt;
  readonly format?: "text" | "markdown";
  /** Transport notification policy for newly persisted outbound messages. */
  readonly notification?: OutboundNotification;
  /** Ephemeral streaming preview; transports must persist finalized content separately. */
  readonly transient?: boolean;
}

/** A transport-native message identifier paired with its issuing transport. */
export interface OutboundReceipt {
  readonly transport: string;
  readonly messageId: string;
}

export interface Reaction {
  readonly emoji: string;
}

export type TransportCapability =
  | "streamingUpdates"
  | "buttons"
  | "multiSelect"
  | "textInput"
  | "attachments"
  | "reactions"
  | "threads";

export interface TransportCapabilities {
  readonly streamingUpdates: boolean;
  readonly buttons: boolean;
  readonly multiSelect: boolean;
  readonly textInput: boolean;
  readonly attachments: boolean;
  readonly reactions: boolean;
  readonly threads: boolean;
  readonly maxMessageLength: number;
}

export interface UiOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface ConfirmUiRequest {
  readonly type: "confirm";
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export interface SelectUiRequest {
  readonly type: "select";
  readonly title: string;
  readonly options: readonly UiOption[];
  readonly multiSelect?: boolean;
}

export interface InputUiRequest {
  readonly type: "input";
  readonly title: string;
  readonly prompt?: string;
  readonly initialValue?: string;
  readonly placeholder?: string;
}

export interface EditorUiRequest {
  readonly type: "editor";
  readonly title: string;
  readonly initialValue: string;
  readonly language?: string;
}

export interface NotifyUiRequest {
  readonly type: "notify";
  readonly message: string;
  readonly level?: "info" | "success" | "warning" | "error";
}

export interface OpenUrlUiRequest {
  readonly type: "open_url";
  readonly url: string;
  readonly label?: string;
}
export interface StatusUiRequest {
  readonly type: "status";
  readonly key: string;
  readonly text?: string;
  readonly notification?: OutboundNotification;
}

export interface WidgetUiRequest {
  readonly type: "widget";
  readonly key: string;
  readonly lines?: readonly string[];
  readonly placement?: "aboveEditor" | "belowEditor";
}

export interface TitleUiRequest {
  readonly type: "title";
  readonly title: string;
}

export interface EditorTextUiRequest {
  readonly type: "editor_text";
  readonly text: string;
}

export type UiRequest =
  | ConfirmUiRequest
  | SelectUiRequest
  | InputUiRequest
  | EditorUiRequest
  | NotifyUiRequest
  | OpenUrlUiRequest
  | StatusUiRequest
  | WidgetUiRequest
  | TitleUiRequest
  | EditorTextUiRequest;

export interface ConfirmUiResponse {
  readonly type: "confirm";
  readonly confirmed: boolean;
}

export interface SelectUiResponse {
  readonly type: "select";
  readonly selected: readonly string[];
}

export type InputUiResponse =
  | { readonly type: "input"; readonly cancelled: true }
  | { readonly type: "input"; readonly cancelled: false; readonly value: string };

export type EditorUiResponse =
  | { readonly type: "editor"; readonly cancelled: true }
  | { readonly type: "editor"; readonly cancelled: false; readonly value: string };

export interface NotifyUiResponse {
  readonly type: "notify";
  readonly acknowledged: true;
}

export interface OpenUrlUiResponse {
  readonly type: "open_url";
  readonly opened: boolean;
}
export interface StatusUiResponse {
  readonly type: "status";
  readonly acknowledged: true;
}

export interface WidgetUiResponse {
  readonly type: "widget";
  readonly acknowledged: true;
}

export interface TitleUiResponse {
  readonly type: "title";
  readonly acknowledged: true;
}

export interface EditorTextUiResponse {
  readonly type: "editor_text";
  readonly acknowledged: true;
}

export type UiResponse =
  | ConfirmUiResponse
  | SelectUiResponse
  | InputUiResponse
  | EditorUiResponse
  | NotifyUiResponse
  | OpenUrlUiResponse
  | StatusUiResponse
  | WidgetUiResponse
  | TitleUiResponse
  | EditorTextUiResponse;

export type UiResponseFor<Request extends UiRequest> = Extract<UiResponse, { readonly type: Request["type"] }>;

export type ReceiveInbound = (envelope: InboundEnvelope, signal?: AbortSignal) => Promise<void>;

export type ResolveTransportIdentity = (
  identity: TransportIdentity,
  signal?: AbortSignal,
) => Principal | undefined | Promise<Principal | undefined>;

export interface TransportStartContext {
  readonly receive: ReceiveInbound;
  readonly resolveIdentity: ResolveTransportIdentity;
  readonly signal?: AbortSignal;
}

export interface TransportAdapter {
  readonly id: string;
  readonly capabilities: TransportCapabilities;
  start(context: TransportStartContext): void | Promise<void>;
  stop(): void | Promise<void>;
  send(
    address: ConversationAddress,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt>;
  typing?(address: ConversationAddress, context: DeliveryContext, signal?: AbortSignal): Promise<void>;
  update?(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt>;
  finalize(
    address: ConversationAddress,
    receipt: OutboundReceipt | undefined,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly OutboundReceipt[]>;
  react?(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    reaction: Reaction,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void>;
  presentUi?<Request extends UiRequest>(
    address: ConversationAddress,
    request: Request,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<UiResponseFor<Request>>;
}

export class UnsupportedTransportCapabilityError extends Error {
  readonly name = "UnsupportedTransportCapabilityError";

  constructor(
    readonly transport: string,
    readonly capability: TransportCapability,
  ) {
    super(`Transport ${transport} does not support ${capability}`);
  }
}
