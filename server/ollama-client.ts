import type { ConversationStep, ReasoningEffort, ToolDefinition } from "./types.js";
import { randomUUID } from "node:crypto";

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api";

interface StreamChunk {
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: Record<string, unknown>;
      };
    }>;
  };
}

function createStep(
  kind: ConversationStep["kind"],
  title: string,
  content: string,
  toolCall?: ConversationStep["toolCall"]
): ConversationStep {
  return {
    id: randomUUID(),
    kind,
    title,
    content,
    createdAt: new Date().toISOString(),
    expanded: true,
    toolCall,
  };
}

interface ShowResponse {
  license?: string;
  modelfile?: string;
  parameters?: string;
  template?: string;
  system?: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  model_info?: Record<string, string | number | boolean | undefined>;
  capabilities?: string[];
  modified_at?: string;
}

export async function fetchOllamaModelMeta(
  baseUrl: string,
  modelName: string
): Promise<ShowResponse> {
  const response = await fetch(`${baseUrl}/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName }),
  });

  if (!response.ok) {
    throw new Error(`Ollama /show failed: ${response.status}`);
  }

  return (await response.json()) as ShowResponse;
}

export function buildOllamaChatBody(args: {
  model: string;
  steps: ConversationStep[];
  tools: ToolDefinition[];
  stream: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
}) {
  const { model, steps, tools, stream, temperature, maxOutputTokens, reasoningEffort } = args;

  const options: Record<string, unknown> = {};
  if (temperature != null) options.temperature = temperature;
  if (maxOutputTokens != null) options.num_predict = maxOutputTokens;

  // Ollama's `think` field accepts a boolean (true/false to enable/disable
  // thinking entirely) or a string level ("low" | "medium" | "high") on
  // models that support graded reasoning effort.
  const thinkValue: boolean | string | undefined =
    reasoningEffort == null
      ? undefined
      : reasoningEffort === "disable"
        ? false
        : reasoningEffort;

  return {
    model,
    stream,
    messages: toOllamaMessages(steps),
    tools: tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: parseToolSchema(tool.inputSchema),
      },
    })),
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(thinkValue !== undefined ? { think: thinkValue } : {}),
  };
}

export async function streamOllamaResponse(args: {
  baseUrl?: string;
  model: string;
  steps: ConversationStep[];
  tools: ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  onDelta: (steps: ConversationStep[]) => void;
  signal?: AbortSignal;
}): Promise<ConversationStep[]> {
  const { baseUrl = DEFAULT_OLLAMA_URL, model, steps, tools, temperature, maxOutputTokens, reasoningEffort, onDelta, signal } = args;

  const body = buildOllamaChatBody({ model, steps, tools, stream: true, temperature, maxOutputTokens, reasoningEffort });
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Ollama request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const assistantStep = createStep("assistant", "Assistant", "");
  let reasoningStep: ConversationStep | undefined;
  const toolSteps: ConversationStep[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const result = processStreamLine(line, assistantStep, reasoningStep, toolSteps, onDelta);
      if (result.reasoningStep) reasoningStep = result.reasoningStep;
      if (result.done) return result.steps!;
    }
  }

  if (buffer.trim()) {
    const result = processStreamLine(buffer, assistantStep, reasoningStep, toolSteps, onDelta);
    if (result.reasoningStep) reasoningStep = result.reasoningStep;
    if (result.done) return result.steps!;
  }

  return compactSteps(reasoningStep, assistantStep, toolSteps);
}

function processStreamLine(
  line: string,
  assistantStep: ConversationStep,
  reasoningStep: ConversationStep | undefined,
  toolSteps: ConversationStep[],
  onDelta: (steps: ConversationStep[]) => void
): { done: boolean; steps?: ConversationStep[]; reasoningStep?: ConversationStep } {
  const trimmed = line.trim();
  if (!trimmed) return { done: false };

  const chunk = JSON.parse(trimmed) as StreamChunk;

  if (chunk.message?.content) {
    assistantStep.content += chunk.message.content;
    (assistantStep.contentTokens ??= []).push(chunk.message.content);
  }

  if (chunk.message?.thinking) {
    if (!reasoningStep) {
      reasoningStep = createStep("reasoning", "Reasoning", "");
    }
    reasoningStep.content += chunk.message.thinking;
    (reasoningStep.contentTokens ??= []).push(chunk.message.thinking);
  }

  for (const toolCall of chunk.message?.tool_calls ?? []) {
    const name = toolCall.function?.name ?? "tool_call";
    const nextToolStep = createStep("tool_call", "Tool Call", "", {
      name,
      arguments: toolCall.function?.arguments ?? {},
    });

    const duplicate = toolSteps.some(
      (step) =>
        step.toolCall?.name === nextToolStep.toolCall?.name &&
        JSON.stringify(step.toolCall?.arguments) ===
          JSON.stringify(nextToolStep.toolCall?.arguments)
    );

    if (!duplicate) {
      toolSteps.push(nextToolStep);
    }
  }

  const nextSteps = compactSteps(reasoningStep, assistantStep, toolSteps);
  onDelta(nextSteps);

  if (chunk.done) {
    if (chunk.prompt_eval_count != null || chunk.eval_count != null || chunk.done_reason) {
      assistantStep.usage = {
        ...(chunk.prompt_eval_count != null ? { inputTokens: chunk.prompt_eval_count } : {}),
        ...(chunk.eval_count != null ? { outputTokens: chunk.eval_count } : {}),
        ...(chunk.done_reason ? { stopReason: chunk.done_reason } : {}),
      };
    }
    return { done: true, steps: nextSteps, reasoningStep };
  }

  return { done: false, reasoningStep };
}

function compactSteps(
  reasoningStep: ConversationStep | undefined,
  assistantStep: ConversationStep,
  toolSteps: ConversationStep[]
): ConversationStep[] {
  const visibleAssistantStep =
    assistantStep.content.trim().length > 0 ? assistantStep : undefined;
  return [reasoningStep, ...toolSteps, visibleAssistantStep].filter(
    Boolean
  ) as ConversationStep[];
}

function toOllamaMessages(steps: ConversationStep[]) {
  const messages: Array<Record<string, unknown>> = [];
  let pendingToolCalls: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }> = [];

  for (const step of steps) {
    if (step.kind === "meta") continue;

    if (step.kind === "system") {
      if (step.content.trim().length > 0) {
        flushPendingToolCalls(messages, pendingToolCalls);
        pendingToolCalls = [];
        messages.push({ role: "system", content: step.content });
      }
      continue;
    }

    if (step.kind === "user" || step.kind === "assistant") {
      if (pendingToolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: step.kind === "assistant" ? step.content : "",
          tool_calls: pendingToolCalls,
        });
        pendingToolCalls = [];
        if (step.kind === "assistant") continue;
      }
      messages.push({ role: step.kind, content: step.content });
      continue;
    }

    if (step.kind === "tool_call" && step.toolCall) {
      pendingToolCalls.push({
        function: {
          name: step.toolCall.name,
          arguments: step.toolCall.arguments,
        },
      });
      continue;
    }

    if (step.kind === "tool_result" && step.toolResult) {
      flushPendingToolCalls(messages, pendingToolCalls);
      pendingToolCalls = [];
      messages.push({
        role: "tool",
        content: step.content,
        tool_name: step.toolResult.name,
      });
    }
  }

  flushPendingToolCalls(messages, pendingToolCalls);

  return messages;
}

function flushPendingToolCalls(
  messages: Array<Record<string, unknown>>,
  pendingToolCalls: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>
) {
  if (pendingToolCalls.length === 0) return;
  messages.push({
    role: "assistant",
    content: "",
    tool_calls: pendingToolCalls,
  });
}

function parseToolSchema(inputSchema: string) {
  try {
    const parsed = JSON.parse(inputSchema) as Record<string, unknown>;
    if ("type" in parsed || "properties" in parsed) return parsed;

    const properties = Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => {
        const rawType = typeof value === "string" ? value : "string";
        const normalizedType = rawType.replace("?", "").trim().toLowerCase();
        return [
          key,
          {
            type:
              normalizedType === "number" || normalizedType === "integer"
                ? "number"
                : normalizedType === "boolean"
                  ? "boolean"
                  : "string",
          },
        ];
      })
    );

    const required = Object.entries(parsed)
      .filter(([, value]) => typeof value === "string" && !value.includes("?"))
      .map(([key]) => key);

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  } catch {
    return {
      type: "object",
      properties: {
        raw_input: { type: "string", description: inputSchema },
      },
    };
  }
}
