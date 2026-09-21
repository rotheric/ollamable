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
  | "meta";

export interface UsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
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
  | "fetch_result";

export interface MetaEvent {
  id: string;
  kind: MetaEventKind;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
  timestamp: string;
  durationMs?: number;
}

// Client → Server messages
export type ClientMessage =
  | {
      type: "chat.send";
      conversationId: string;
      model: string;
      provider?: string;
      steps: ConversationStep[];
      tools: ToolDefinition[];
      temperature?: number;
      maxOutputTokens?: number;
      reasoningEffort?: ReasoningEffort;
    }
  | { type: "chat.stop"; conversationId: string }
  | { type: "ping" };

// Server → Client messages
export type ServerMessage =
  | { type: "chat.delta"; conversationId: string; steps: ConversationStep[] }
  | { type: "chat.steps"; conversationId: string; steps: ConversationStep[] }
  | { type: "chat.done"; conversationId: string; steps: ConversationStep[] }
  | { type: "chat.error"; conversationId: string; message: string }
  | { type: "meta.event"; conversationId: string; event: MetaEvent }
  | { type: "tools.update"; tools: ToolDefinition[] }
  | { type: "pong" };
