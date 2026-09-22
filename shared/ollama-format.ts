/**
 * Shared conversion: ConversationStep[] → Ollama /api/chat message list.
 *
 * Single implementation consumed identically by server/ollama-client.ts
 * (building the real outgoing request) and src/lib/token-view.ts (the
 * request-preview panel's reconciliation/rendering source). Before this
 * file existed, each side hand-kept its own copy of this filtering logic;
 * they drifted — a system step after a pending tool call, a tool_call
 * step missing its `toolCall` payload, and a tool_result step missing
 * its `toolResult` payload all filtered differently on the two sides.
 * Precedent: shared/openai-format.ts, per architecture.md's Boundary
 * Rule 1/2 — this is a wire-format builder consumed identically on both
 * sides of the server/src split, expressed as a minimal structural
 * interface (`FormatStep`, reused from shared/openai-format.ts) rather
 * than a cross-boundary import.
 */

import type { FormatStep } from "./openai-format.js";

/** A single outgoing message as Ollama's /api/chat would receive it. */
export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

/**
 * Filters and reshapes `steps` into the exact message list Ollama's
 * /api/chat expects: `meta` steps are skipped; empty `system` steps are
 * dropped; a run of pending `tool_call` steps (each requiring a
 * `toolCall` payload) is flushed as a single synthetic assistant message
 * — carrying the following step's own content only when that step is
 * itself `assistant` — immediately before a `user`/`assistant`/
 * `tool_result` step is pushed, or at the end of the list if any remain
 * unflushed; a `tool_result` step is only emitted when it carries a
 * `toolResult` payload.
 */
export function toOllamaMessages(steps: FormatStep[]): OllamaChatMessage[] {
  const messages: OllamaChatMessage[] = [];
  let pendingToolCalls: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }> = [];

  for (const step of steps) {
    // Kept for legibility, not for effect: a `meta` step matches none of
    // the branches below, so it is dropped with or without this guard.
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
  messages: OllamaChatMessage[],
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
