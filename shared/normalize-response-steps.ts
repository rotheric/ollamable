import type { FormatStep } from "./openai-format.js";

interface StoredStep extends FormatStep {
  id: string;
  title: string;
  createdAt: string;
  usage?: { inputTokens?: number; outputTokens?: number; stopReason?: string };
}

/** Migrate old merged responses without manufacturing assistant messages.
 * Calls precede prose so both provider formatters can build their wire envelope.
 * Stable derived IDs make repeated migration and streaming upserts idempotent.
 */
export function normalizeResponseSteps<T extends StoredStep>(steps: T[]): T[] {
  return steps.flatMap((step): T[] => {
    if (step.kind !== "assistant") return [step];
    const { toolCalls, ...prose } = step;
    const hasProse = step.content.trim().length > 0;
    const calls = (toolCalls ?? []).map((toolCall, index) => ({
      id: `${step.id}:tool:${index}`, kind: "tool_call", title: "Tool Call",
      content: "", createdAt: step.createdAt, toolCall,
      ...(hasProse || index !== 0 ? {} : { usage: step.usage }),
      ...("expanded" in step ? { expanded: step.expanded } : {}),
      ...("model" in step ? { model: step.model } : {}),
    } as T));
    if (hasProse) return [...calls, prose as T];
    if (calls.length) return calls;
    if (step.usage) return [{ ...prose, kind: "meta", title: "Model usage" } as T];
    return [];
  });
}
