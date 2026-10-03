import { retainResponseUsage } from "./response-usage.js";
import { withNetworkDeadline } from "./network-deadline.js";
/**
 * OpenAI-compatible API client for providers like MiniMax.
 *
 * Handles the SSE streaming format used by the OpenAI chat completions API
 * and converts responses into the same ConversationStep[] format that the
 * Ollama client produces so the rest of the backend is provider-agnostic.
 *
 * Key differences from Ollama:
 *  - Streaming uses SSE (data: {...}\n\n) instead of NDJSON
 *  - Tool call arguments arrive as incremental string fragments
 *  - Tool calls carry an `id` that must be referenced in tool results
 *  - Temperature is a top-level field, not nested in `options`
 */

import type { ConversationStep, ReasoningEffort, ToolDefinition } from "./types.js";
import type { ProviderConfig } from "./provider-config.js";
import { randomUUID } from "node:crypto";
import { toOpenAIMessages, parseToolSchema } from "../shared/openai-format.js";

// ── SSE chunk shape ──────────────────────────────────────────────────

interface SseChunk {
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

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

// ── Model listing ────────────────────────────────────────────────────

interface ModelsResponse {
  data: Array<{ id: string; owned_by?: string }>;
}

export async function fetchOpenAIModels(
  config: ProviderConfig,
  callerSignal?: AbortSignal
): Promise<Array<{ id: string; ownedBy?: string }>> {
  return withNetworkDeadline(async (signal) => {
    const response = await fetch(`${config.baseUrl}/models`, {
      signal,
      headers: {
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch models from ${config.name}: ${response.status}`
      );
    }

    const data = (await response.json()) as ModelsResponse;
    return data.data.map((m) => ({ id: m.id, ownedBy: m.owned_by }));
  }, callerSignal);
}

// ── Streaming chat completions ───────────────────────────────────────

/**
 * Provider base URLs that rejected `stream_options` (in-process memory only). Strict
 * OpenAI-compatible servers answer 4xx to the unknown field; for them usage stays unknown.
 */
const streamOptionsRejectedBy = new Set<string>();

/** A 4xx whose error body names the field we added (`stream_options` / `include_usage`). */
async function rejectsStreamOptions(response: Response): Promise<boolean> {
  // Auth and rate-limit errors say nothing about the field, whatever their body mentions.
  if (response.status < 400 || response.status >= 500 || [401, 403, 429].includes(response.status)) return false;
  return /stream_options|include_usage/.test(await readBoundedBody(response, ERROR_BODY_MAX_BYTES, ERROR_BODY_TIMEOUT_MS));
}

const ERROR_BODY_MAX_BYTES = 8 * 1024;
const ERROR_BODY_TIMEOUT_MS = 2000;

/**
 * At most `maxBytes` of the body, or "" when it errors (e.g. the request was aborted) or does not
 * finish within `timeoutMs`; a stalled error body must not hang the chat. The reader is cancelled
 * in every case.
 */
async function readBoundedBody(response: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  const read = (async () => {
    while (bytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), timeoutMs); });
  try {
    return await Promise.race([read, timeout]);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
    read.catch(() => {});
  }
}

export async function streamOpenAIResponse(args: {
  config: ProviderConfig;
  model: string;
  steps: ConversationStep[];
  tools: ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  onDelta: (steps: ConversationStep[]) => void;
  signal?: AbortSignal;
}): Promise<ConversationStep[]> {
  const { config, model, steps, tools, temperature, maxOutputTokens, reasoningEffort, onDelta, signal } = args;

  const body: Record<string, unknown> = {
    model,
    stream: true,
    // Without this, OpenAI-compatible streams report no usage and the context fill is unknown.
    // Omitted for providers that rejected it earlier (see `streamOptionsRejectedBy`).
    ...(streamOptionsRejectedBy.has(config.baseUrl) ? {} : { stream_options: { include_usage: true } }),
    messages: toOpenAIMessages(steps),
  };

  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: parseToolSchema(tool.inputSchema),
      },
    }));
  }

  if (temperature != null) {
    body.temperature = temperature;
  }

  if (maxOutputTokens != null) {
    body.max_tokens = maxOutputTokens;
  }

  if (reasoningEffort != null) {
    // Map our "disable" semantic to OpenAI's "minimal" (gpt-5+).
    body.reasoning_effort = reasoningEffort === "disable" ? "minimal" : reasoningEffort;
  }

  const post = () => fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  let response = await post();
  if (body.stream_options && (await rejectsStreamOptions(response))) {
    // Retry exactly once without the field; remember the provider only if that retry succeeds.
    delete body.stream_options;
    response = await post();
    if (response.ok) streamOptionsRejectedBy.add(config.baseUrl);
  }

  if (!response.ok || !response.body) {
    throw new Error(`${config.name} request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const reasoningStep = createStep("reasoning", "Reasoning", "");
  const assistantStep = createStep("assistant", "Assistant", "");
  const toolSteps: ConversationStep[] = [];

  // Tool call arguments arrive as incremental string fragments keyed by index.
  const pendingToolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let lastUsage: SseChunk["usage"];
  let finishReason: string | undefined;

  // Tracks whether we're inside a <think>…</think> region so content
  // arriving across multiple SSE chunks is routed to the reasoning step.
  const thinkState = { inside: false, pending: "" };

  while (true) {
    const { value, done } = await reader.read();
    if (done) { buffer += decoder.decode(); break; }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      processLine(
        line,
        assistantStep,
        reasoningStep,
        thinkState,
        toolSteps,
        pendingToolCalls,
        (u) => { lastUsage = u; },
        (r) => { finishReason = r; }
      );

      const current = compactSteps(
        reasoningStep,
        assistantStep,
        materialiseToolSteps(pendingToolCalls, toolSteps)
      );
      onDelta(current);
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      processLine(
        line,
        assistantStep,
        reasoningStep,
        thinkState,
        toolSteps,
        pendingToolCalls,
        (u) => { lastUsage = u; },
        (r) => { finishReason = r; }
      );
    }
  }

  // A partial delimiter at EOF is ordinary text in the current region.
  (thinkState.inside ? reasoningStep : assistantStep).content += thinkState.pending;
  thinkState.pending = "";

  // Finalise tool steps with fully accumulated arguments
  const finalToolSteps = materialiseToolSteps(pendingToolCalls, toolSteps, true);

  // The stream completed (aborts throw above): always attach a usage object, even an empty one, so
  // a response that reported nothing is a boundary for `lastUsedTokens`, not skipped for an older figure.
  assistantStep.usage = {
    ...(lastUsage?.prompt_tokens != null ? { inputTokens: lastUsage.prompt_tokens } : {}),
    ...(lastUsage?.completion_tokens != null ? { outputTokens: lastUsage.completion_tokens } : {}),
    ...(finishReason ? { stopReason: finishReason } : {}),
  };

  return retainResponseUsage(compactSteps(reasoningStep, assistantStep, finalToolSteps), assistantStep.usage, assistantStep);
}

// ── SSE line processing ──────────────────────────────────────────────

/**
 * Route a content fragment to the reasoning or assistant step depending on
 * whether we are inside a `<think>…</think>` region.  Handles fragments that
 * contain the opening tag, the closing tag, both, or neither.
 */
function routeContent(
  fragment: string,
  assistantStep: ConversationStep,
  reasoningStep: ConversationStep,
  thinkState: { inside: boolean; pending: string }
): void {
  let remaining = thinkState.pending + fragment;
  thinkState.pending = "";
  while (remaining.length > 0) {
    const delimiter = thinkState.inside ? "</think>" : "<think>";
    const destination = thinkState.inside ? reasoningStep : assistantStep;
    const index = remaining.indexOf(delimiter);
    if (index !== -1) {
      destination.content += remaining.slice(0, index);
      remaining = remaining.slice(index + delimiter.length);
      thinkState.inside = !thinkState.inside;
      continue;
    }
    // Hold only a suffix that could become a delimiter in the next fragment.
    let prefixLength = Math.min(remaining.length, delimiter.length - 1);
    while (prefixLength > 0 && !delimiter.startsWith(remaining.slice(-prefixLength))) prefixLength--;
    destination.content += remaining.slice(0, remaining.length - prefixLength);
    thinkState.pending = prefixLength ? remaining.slice(-prefixLength) : "";
    break;
  }
}

function processLine(
  raw: string,
  assistantStep: ConversationStep,
  reasoningStep: ConversationStep,
  thinkState: { inside: boolean; pending: string },
  toolSteps: ConversationStep[],
  pendingToolCalls: Map<number, { id: string; name: string; arguments: string }>,
  setUsage: (u: SseChunk["usage"]) => void,
  setFinishReason: (r: string) => void
): void {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "data: [DONE]" || !trimmed.startsWith("data: ")) {
    return;
  }

  let chunk: SseChunk;
  try {
    chunk = JSON.parse(trimmed.slice(6)) as SseChunk;
  } catch {
    return;
  }

  const choice = chunk.choices?.[0];
  if (choice) {
    if (choice.delta.content) {
      routeContent(choice.delta.content, assistantStep, reasoningStep, thinkState);
    }

    for (const tc of choice.delta.tool_calls ?? []) {
      let pending = pendingToolCalls.get(tc.index);
      if (!pending) {
        pending = { id: tc.id ?? randomUUID(), name: "", arguments: "" };
        pendingToolCalls.set(tc.index, pending);
      }
      if (tc.id) pending.id = tc.id;
      if (tc.function?.name) pending.name += tc.function.name;
      if (tc.function?.arguments) pending.arguments += tc.function.arguments;
    }

    if (choice.finish_reason) {
      setFinishReason(choice.finish_reason);
    }
  }

  if (chunk.usage) {
    setUsage(chunk.usage);
  }
}

// ── Tool step materialisation ────────────────────────────────────────

/**
 * Convert accumulated pending tool call data into ConversationStep objects.
 * Already-materialised steps (from earlier delta cycles) are updated in place
 * with the latest accumulated arguments.
 */
function materialiseToolSteps(
  pendingToolCalls: Map<number, { id: string; name: string; arguments: string }>,
  existing: ConversationStep[],
  final = false
): ConversationStep[] {
  const result = [...existing];

  for (const [index, tc] of pendingToolCalls) {
    let parsedArgs: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(tc.arguments);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      parsedArgs = parsed as Record<string, unknown>;
    } catch {
      if (final) throw new Error(`Invalid arguments for tool ${tc.name || tc.id}: expected a complete JSON object`);
      // Partial previews are never execution-ready final calls.
    }
    if (final && !tc.name.trim()) throw new Error(`Missing tool name for call ${tc.id}`);

    if (index < result.length && result[index]?.toolCall) {
      // Update existing step with latest data
      result[index].toolCall!.arguments = parsedArgs;
    } else if (index >= result.length) {
      result.push(
        createStep("tool_call", "Tool Call", "", {
          id: tc.id,
          name: tc.name || "tool_call",
          arguments: parsedArgs,
        })
      );
    }
  }

  return result;
}

// ── Step compaction ──────────────────────────────────────────────────

function compactSteps(
  reasoningStep: ConversationStep,
  assistantStep: ConversationStep,
  toolSteps: ConversationStep[]
): ConversationStep[] {
  const reasoning =
    reasoningStep.content.trim().length > 0 ? reasoningStep : undefined;
  const visible =
    assistantStep.content.trim().length > 0 ? assistantStep : undefined;
  return [reasoning, ...toolSteps, visible].filter(Boolean) as ConversationStep[];
}

// toOpenAIMessages, parseToolSchema — imported from ../shared/openai-format.js
