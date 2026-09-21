import type {
  Conversation,
  ConversationStep,
  OllamaModel,
  StepKind,
  ToolDefinition,
  ToolCallPayload,
  ToolResultPayload,
} from "@/src/types/chat";

export const STORAGE_KEY = "ollamable.conversations";
export const SELECTED_KEY = "ollamable.selectedConversationId";
export const SIDEBAR_STATE_KEY = "ollamable.sidebarState";
export const CONVERSATION_ORDER_KEY = "ollamable.conversationOrder";

export interface SidebarState {
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  modelSectionOpen: boolean;
  reasoningEffortSectionOpen: boolean;
  tempSectionOpen: boolean;
  maxTokensSectionOpen: boolean;
  toolsSectionOpen: boolean;
  clientSectionOpen: boolean;
  renderMarkdown: boolean;
  showTokens: boolean;
  showTour: boolean;
  showExamples: boolean;
  /** Collapse reasoning steps by default */
  collapseReasoning: boolean;
  /** Collapse tool-call result steps by default */
  collapseToolCalls: boolean;
  /** Collapse tool-call request steps by default */
  collapseTools: boolean;
  /** Collapse harness & meta (server) steps by default */
  collapseServerMessages: boolean;
  /** Hide the system prompt text field */
  hideSystemPrompt: boolean;
  /** Per-subsection collapse: key = "builtin" | "mcp-{serverName}" | provider name */
  subsections: Record<string, boolean>;
}

const DEFAULT_SIDEBAR_STATE: SidebarState = {
  sidebarOpen: true,
  rightSidebarOpen: false,
  modelSectionOpen: false,
  reasoningEffortSectionOpen: false,
  tempSectionOpen: false,
  maxTokensSectionOpen: false,
  toolsSectionOpen: false,
  clientSectionOpen: false,
  renderMarkdown: true,
  showTokens: false,
  showTour: true,
  showExamples: true,
  collapseReasoning: false,
  collapseToolCalls: false,
  collapseTools: true,
  collapseServerMessages: false,
  hideSystemPrompt: false,
  subsections: {},
};

export function loadSidebarState(): SidebarState {
  const raw = window.localStorage.getItem(SIDEBAR_STATE_KEY);
  if (!raw) return { ...DEFAULT_SIDEBAR_STATE };
  try {
    return { ...DEFAULT_SIDEBAR_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SIDEBAR_STATE };
  }
}

export function saveSidebarState(state: SidebarState): void {
  window.localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(state));
}

export const fallbackModels: OllamaModel[] = [
  {
    name: "qwen3:latest",
    family: "qwen",
    families: ["qwen"],
    parameterSize: "8B",
  },
  {
    name: "llama3.2:latest",
    family: "llama",
    families: ["llama"],
    parameterSize: "3B",
  },
];

export function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return Math.random().toString(36).slice(2, 10);
}

export function createStep(
  kind: StepKind,
  title: string,
  content: string,
  toolCall?: ToolCallPayload,
  toolResult?: ToolResultPayload
): ConversationStep {
  return {
    id: createId(),
    kind,
    title,
    content,
    createdAt: new Date().toISOString(),
    expanded: true,
    toolCall,
    toolResult,
  };
}

export function createConversation(model: string, tools: ToolDefinition[] = [], provider?: string): Conversation {
  const now = new Date().toISOString();
  const systemStep = createStep("system", "System Prompt", "");

  return {
    id: createId(),
    title: "New conversation",
    titleEdited: false,
    model,
    provider,
    systemPrompt: "",
    createdAt: now,
    updatedAt: now,
    availableTools: tools,
    activeToolIds: [],
    steps: [systemStep],
  };
}

export function inferTitle(steps: ConversationStep[]): string {
  const firstUserStep = steps.find((step) => step.kind === "user");
  if (!firstUserStep) {
    return "New conversation";
  }

  return firstUserStep.content.slice(0, 42) || "New conversation";
}

/**
 * Quota detection across browsers. Modern engines throw a DOMException named
 * "QuotaExceededError"; legacy Firefox used "NS_ERROR_DOM_QUOTA_REACHED", and
 * older engines surface the numeric code 22 instead of a recognisable name.
 * Kept deliberately wide to match `createId`'s degrade-gracefully posture a few
 * lines above, rather than assuming a modern-browser-only audience that nothing
 * in this file actually enforces.
 */
function isQuotaExceeded(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return (
    error.name === "QuotaExceededError" ||
    error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    error.code === 22
  );
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch (error) {
    if (!isQuotaExceeded(error)) {
      throw error;
    }

    const stripped = conversations.map((conversation) => ({
      ...conversation,
      steps: conversation.steps.map((step) => {
        const { contentTokens, ...rest } = step;
        return rest;
      }),
    }));

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
    } catch (retryError) {
      if (!isQuotaExceeded(retryError)) {
        throw retryError;
      }
      // Stripping contentTokens still wasn't enough (e.g. a large
      // transcript). MUST NOT propagate on this retry path — the sole
      // caller is a useEffect, and an uncaught throw there is an
      // unhandled React error that can tear down the workspace.
      console.warn("saveConversations: quota exceeded even after stripping contentTokens; conversations not persisted");
    }
  }
}

export function loadConversationOrder(): string[] | null {
  const raw = window.localStorage.getItem(CONVERSATION_ORDER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
}

export function saveConversationOrder(order: string[]): void {
  window.localStorage.setItem(CONVERSATION_ORDER_KEY, JSON.stringify(order));
}

export function ensureSystemPromptStep(conversation: Conversation): Conversation {
  const systemPrompt = conversation.systemPrompt ?? "";
  const now = new Date().toISOString();
  const existingSystemStep = conversation.steps.find((step) => step.kind === "system");
  const otherSteps = conversation.steps.filter((step) => step.kind !== "system");
  const systemStep =
    existingSystemStep != null
      ? {
          ...existingSystemStep,
          title: "System Prompt",
          content: systemPrompt,
          expanded: existingSystemStep.expanded ?? true,
        }
      : {
          id: createId(),
          kind: "system" as const,
          title: "System Prompt",
          content: systemPrompt,
          createdAt: conversation.createdAt || now,
          expanded: true,
        };

  return {
    ...conversation,
    titleEdited: conversation.titleEdited ?? false,
    systemPrompt,
    availableTools: conversation.availableTools ?? [],
    activeToolIds: conversation.activeToolIds ?? [],
    steps: [systemStep, ...otherSteps],
  };
}

export function loadConversations(tools: ToolDefinition[]): Conversation[] {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [createConversation(fallbackModels[0].name, tools)];
  }

  try {
    const parsed = JSON.parse(raw) as Conversation[];
    return parsed.map((conversation) => ensureConversationTools(ensureSystemPromptStep(conversation), tools));
  } catch {
    return [createConversation(fallbackModels[0].name, tools)];
  }
}

export function ensureConversationTools(
  conversation: Conversation,
  tools: ToolDefinition[]
): Conversation {
  const existingTools = conversation.availableTools ?? [];
  const mergedTools = [
    ...tools,
    ...existingTools.filter(
      (tool) => !tools.some((configuredTool) => configuredTool.id === tool.id)
    ),
  ];
  const activeToolIds = (conversation.activeToolIds ?? []).filter((toolId) =>
    mergedTools.some((tool) => tool.id === toolId)
  );

  return {
    ...conversation,
    availableTools: mergedTools,
    activeToolIds,
  };
}

export function saveSelectedConversationId(id: string): void {
  if (id) {
    window.localStorage.setItem(SELECTED_KEY, id);
    return;
  }

  window.localStorage.removeItem(SELECTED_KEY);
}

export function loadSelectedConversationId(): string | null {
  return window.localStorage.getItem(SELECTED_KEY);
}

import rawExamples from "@/config/system-prompt-examples.yaml";

export interface SystemPromptExample {
  label: string;
  prompt: string;
}

export const SYSTEM_PROMPT_EXAMPLES: SystemPromptExample[] =
  rawExamples as SystemPromptExample[];

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
