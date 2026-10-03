export type StepKind =
  | "system"
  | "user"
  | "assistant"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "meta"
  /** A fork's opening summary written by the model via `compact_context`; sent to the model as a user turn. */
  | "compaction";

export type MetaEventKind =
  | "mcp_connect"
  | "mcp_call"
  | "mcp_result"
  | "search_start"
  | "search_result"
  | "fetch_start"
  | "fetch_result"
  | "compaction";

export interface MetaEventPayload {
  kind: MetaEventKind;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
  durationMs?: number;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: string;
}

export interface ToolCallPayload {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultPayload {
  id?: string;
  name: string;
}

export interface UsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
}

/** Where a resolved context window came from. Mirrored in server/types.ts (no cross-boundary import). */
export type ContextWindowSource = "runtime" | "modelfile" | "estimated" | "assumed";

/** `POST /models/runtime` response: what the backend can report about a loaded model. */
export interface ModelRuntime {
  loaded: boolean;
  /** Whether `POST /models/show` can answer for this model (Ollama only). */
  metadata: boolean;
  /** Present, as a positive integer, only when `loaded` is true. */
  contextLength?: number;
}

export type ReasoningEffort = "disable" | "low" | "medium" | "high";

export interface ConversationStep {
  id: string;
  kind: StepKind;
  title: string;
  content: string;
  createdAt: string;
  expanded?: boolean;
  toolCall?: ToolCallPayload;
  toolCalls?: ToolCallPayload[];
  toolResult?: ToolResultPayload;
  metaEvent?: MetaEventPayload;
  usage?: UsagePayload;
  contentTokens?: string[];
  model?: string;
  interrupted?: boolean;
}

/**
 * The inputs that determined a request's usage note, recorded when the request was sent (never the
 * note text, which must not be stored with the conversation). `startIndex` is the length of the
 * step list that was sent, i.e. the index of the request's first new step; within one request
 * these inputs are constant, so the note any of its invocations received can be reproduced.
 */
export interface RequestContextRecord {
  startIndex: number;
  compactEnabled: boolean;
  contextWindow?: { tokens: number; source: ContextWindowSource };
  modelFamily?: string;
}

export interface Conversation {
  id: string;
  title: string;
  titleEdited?: boolean;
  model: string;
  provider?: string;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Per-request execution budget (model invocations / tool calls); the server caps both. */
  maxModelInvocations?: number;
  maxToolCalls?: number;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  availableTools: ToolDefinition[];
  activeToolIds: string[];
  steps: ConversationStep[];
  /** One record per sent request (ascending `startIndex`); see `RequestContextRecord`. */
  requestContexts?: RequestContextRecord[];
  /** Set on a conversation forked by `compact_context`: the conversation and `tool_call` step it was compacted from. */
  forkedFrom?: { conversationId: string; stepId: string };
  note?: string;
  _tourExample?: boolean;
  /** Original example content, retained across reloads for safe tour cleanup. */
  _tourSeed?: string;
}

/**
 * Seam S-COMPACTION-WIRE (mirror of server/types.ts, deliberately not imported): the payload of a
 * `chat.done` that ended with a valid sole `compact_context` call. `toolCallStepId` is the id of
 * that call's `tool_call` step among the same `chat.done` steps; `remainingWork` is omitted when absent.
 */
export interface CompactionPayload {
  toolCallStepId: string;
  summary: string;
  remainingWork?: string;
}

export interface OllamaModel {
  name: string;
  provider?: string;
  providerName?: string;
  parameterSize?: string;
  family?: string;
  families?: string[];
  modifiedAt?: string;
  parentModel?: string;
  format?: string;
  quantizationLevel?: string;
  capabilities?: string[];
}

/** `tokenize.error`'s typed reason enum. Mirrors server/types.ts's
 *  ClientMessage/ServerMessage duplication convention — no import across
 *  the server/src boundary (architecture.md Boundary Rule 1). */
export type TokenizeErrorReason = "unsupported_provider" | "vocab_unavailable" | "too_large" | "internal";

/** `tokenize` client message (epic-token-view story S3). backend-client.ts
 *  mints `requestId` and correlates the response via its own map, ahead
 *  of the conversationId-gated `pending` guard used for chat messages. */
export interface TokenizeRequestMessage {
  type: "tokenize";
  requestId: string;
  model: string;
  text: string;
  /**
   * Sourced from the conversation's own `provider` field (mirroring
   * `chat.send`), so tokenize resolves the exact same provider the
   * conversation's chat used rather than falling through to
   * `modelProviderMap`'s model-name-only, last-writer-wins fallback
   * (S3-F4).
   */
  provider?: string;
}

/** `tokenize.result` / `tokenize.error` server messages. */
export type TokenizeResponseMessage =
  | { type: "tokenize.result"; requestId: string; tokens: string[]; tokenIds: number[] }
  | { type: "tokenize.error"; requestId: string; reason: TokenizeErrorReason };

export interface OllamaModelMeta {
  name: string;
  modifiedAt?: string;
  family?: string;
  families?: string[];
  parentModel?: string;
  format?: string;
  parameterSize?: string;
  quantizationLevel?: string;
  license?: string;
  system?: string;
  template?: string;
  parameters?: string;
  details?: Record<string, string | number | boolean | string[] | undefined>;
  modelInfo?: Record<string, string | number | boolean | undefined>;
  capabilities?: string[];
}
