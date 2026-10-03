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

export interface UsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
}

/** `POST /models/runtime` response. Mirrored in src/types/chat.ts (no cross-boundary import). */
export interface ModelRuntimeInfo {
  loaded: boolean;
  /** Whether `POST /models/show` can answer for this model (Ollama only). */
  metadata: boolean;
  /** Present, as a positive integer, only when `loaded` is true. */
  contextLength?: number;
}

/** Where a resolved context window came from. Mirrored in src/types/chat.ts (no cross-boundary import). */
export type ContextWindowSource ="runtime" | "modelfile" | "estimated" | "assumed";

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
}

export interface MetaEventPayload {
  kind: MetaEventKind;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
  durationMs?: number;
}

export type MetaEventKind =
  | "mcp_connect"
  | "mcp_call"
  | "mcp_result"
  | "search_start"
  | "search_result"
  | "fetch_start"
  | "fetch_result"
  | "compaction";

export interface MetaEvent {
  id: string;
  kind: MetaEventKind;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
  timestamp: string;
  durationMs?: number;
}

/** `tokenize.error`'s typed reason enum (epic-token-view story S3). No
 *  precedent elsewhere in this protocol — every other error path
 *  (`chat.error`) is an untyped message string. */
export type TokenizeErrorReason = "unsupported_provider" | "vocab_unavailable" | "too_large" | "internal";

// Client → Server messages
export type ClientMessage =
  | {
      type: "chat.send";
      requestId?: string;
      conversationId: string;
      model: string;
      provider?: string;
      steps: ConversationStep[];
      tools: ToolDefinition[];
      temperature?: number;
      maxOutputTokens?: number;
      reasoningEffort?: ReasoningEffort;
      /** Per-request execution budget; the server caps both at its configured ceilings. */
      maxModelInvocations?: number;
      maxToolCalls?: number;
      /** Resolved context window, validated at the boundary; used only for the usage note and placement, never sent to the provider. */
      contextWindow?: number;
      contextWindowSource?: ContextWindowSource;
      modelFamily?: string;
    }
  | { type: "chat.stop"; requestId?: string; conversationId: string }
  | { type: "tokenize"; requestId: string; model: string; text: string; provider?: string }
  | { type: "ping" };

/**
 * Seam S-COMPACTION-WIRE: set on `chat.done` when the model ended the turn with a valid sole
 * `compact_context` call. `toolCallStepId` references that call's `tool_call` step in the same
 * `chat.done` steps; `remainingWork` is omitted, never empty. Mirrored in src/types/chat.ts.
 */
export interface CompactionPayload {
  toolCallStepId: string;
  summary: string;
  remainingWork?: string;
}

// Server → Client messages
export type ServerMessage =
  | { type: "protocol.error"; message: string }
  | { type: "chat.delta"; requestId?: string; conversationId: string; steps: ConversationStep[] }
  | { type: "chat.steps"; requestId?: string; conversationId: string; steps: ConversationStep[] }
  | { type: "chat.done"; requestId?: string; conversationId: string; steps: ConversationStep[]; compaction?: CompactionPayload }
  | { type: "chat.error"; requestId?: string; conversationId: string; message: string }
  | { type: "meta.event"; requestId?: string; conversationId: string; event: MetaEvent }
  | { type: "tools.update"; tools: ToolDefinition[] }
  | { type: "tokenize.result"; requestId: string; tokens: string[]; tokenIds: number[] }
  | { type: "tokenize.error"; requestId: string; reason: TokenizeErrorReason }
  | { type: "pong" };
