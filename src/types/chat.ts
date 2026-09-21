export type StepKind =
  | "system"
  | "user"
  | "assistant"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "meta";

export type MetaEventKind =
  | "mcp_connect"
  | "mcp_call"
  | "mcp_result"
  | "search_start"
  | "search_result"
  | "fetch_start"
  | "fetch_result";

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

export interface Conversation {
  id: string;
  title: string;
  titleEdited?: boolean;
  model: string;
  provider?: string;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  availableTools: ToolDefinition[];
  activeToolIds: string[];
  steps: ConversationStep[];
  note?: string;
  _tourExample?: boolean;
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
