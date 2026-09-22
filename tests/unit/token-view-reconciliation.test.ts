/**
 * Unit tests for src/lib/token-view.ts's S4 additions — outgoing-message
 * filtering and content-token reconciliation for the request-preview
 * panel (epic-token-view story S4).
 *
 * Covers AC-UX-5 (outgoing-message filtering that must never diverge from
 * server/ollama-client.ts's toOllamaMessages), AC-UX-6 (three-figure
 * reconciliation, tool-call-turn unavailable path), and the VQ-S4-005
 * requirement that the reconciliation path never references
 * requestJsonPreview/buildOpenAIRequestBody/toOpenAIMessages.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { ConversationStep } from "@/src/types/chat";
import {
  TEMPLATE_OVERHEAD_LABEL,
  RECONCILIATION_TOOL_CALL_REASON,
  RECONCILIATION_FAILED_REASON,
  toOllamaFilteredMessages,
  findLastUsageStep,
  turnHasToolCall,
  useTokenizedMessages,
  useReconciliation,
} from "@/src/lib/token-view";

function step(overrides: Partial<ConversationStep> & { kind: ConversationStep["kind"] }): ConversationStep {
  return {
    id: Math.random().toString(36).slice(2),
    title: "",
    content: "",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("toOllamaFilteredMessages — matches these expected filtering outcomes (congruence with server/ollama-client.ts's toOllamaMessages is asserted separately, against both production entry points, in tests/integration/ollama-format-congruence.test.ts)", () => {
  it("skips meta steps and drops an empty system step", () => {
    const steps = [
      step({ kind: "system", content: "" }),
      step({ kind: "meta", content: "ignored" }),
      step({ kind: "user", content: "hi" }),
    ];
    expect(toOllamaFilteredMessages(steps)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps a non-empty system message and orders system/user/assistant as sent", () => {
    const steps = [
      step({ kind: "system", content: "be terse" }),
      step({ kind: "user", content: "hi" }),
      step({ kind: "assistant", content: "hello" }),
    ];
    expect(toOllamaFilteredMessages(steps)).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("flushes a pending tool_call as a synthetic assistant message before a tool_result", () => {
    const steps = [
      step({ kind: "user", content: "what's the weather" }),
      step({ kind: "tool_call", content: "", toolCall: { name: "get_weather", arguments: {} } }),
      step({ kind: "tool_result", content: "72F", toolResult: { name: "get_weather" } }),
      step({ kind: "assistant", content: "It's 72F." }),
    ];
    expect(toOllamaFilteredMessages(steps)).toEqual([
      { role: "user", content: "what's the weather" },
      { role: "assistant", content: "" },
      { role: "tool", content: "72F" },
      { role: "assistant", content: "It's 72F." },
    ]);
  });

  it("flushes a trailing pending tool_call left at the end of the slice", () => {
    const steps = [
      step({ kind: "user", content: "hi" }),
      step({ kind: "tool_call", content: "", toolCall: { name: "noop", arguments: {} } }),
    ];
    expect(toOllamaFilteredMessages(steps)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
    ]);
  });

  it("a tool_call step missing its toolCall payload is NOT treated as a pending call (S4-F1's case D)", () => {
    const steps = [
      step({ kind: "user", content: "q" }),
      step({ kind: "tool_call", content: "" }),
      step({ kind: "user", content: "q2" }),
    ];
    expect(toOllamaFilteredMessages(steps)).toEqual([
      { role: "user", content: "q" },
      { role: "user", content: "q2" },
    ]);
  });

  it("a tool_result step missing its toolResult payload is dropped entirely (S4-F1's case E)", () => {
    const steps = [
      step({ kind: "user", content: "q" }),
      step({ kind: "tool_result", content: "r" }),
      step({ kind: "user", content: "q2" }),
    ];
    expect(toOllamaFilteredMessages(steps)).toEqual([
      { role: "user", content: "q" },
      { role: "user", content: "q2" },
    ]);
  });

  it("a system step arriving after a pending tool_call flushes it first, rather than silently dropping it (S4-F1's case C)", () => {
    const steps = [
      step({ kind: "user", content: "q" }),
      step({ kind: "tool_call", content: "", toolCall: { name: "get_weather", arguments: {} } }),
      step({ kind: "system", content: "sys" }),
      step({ kind: "user", content: "q2" }),
    ];
    expect(toOllamaFilteredMessages(steps)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "" },
      { role: "system", content: "sys" },
      { role: "user", content: "q2" },
    ]);
  });

  it("this predicate — not requestJsonPreview's buildOpenAIRequestBody/toOpenAIMessages filtering — is what a tool_call/tool_result pair around a system step must be reconciled against", () => {
    // A fixture where the OpenAI-shaped filter (toOpenAIMessages) and the
    // Ollama-shaped filter (toOllamaFilteredMessages) diverge: the
    // OpenAI shape keeps a `tool_calls` array on the SAME assistant
    // message that also carries any trailing text, while the Ollama
    // shape here always synthesizes a separate, content-less assistant
    // message ahead of the tool result. Asserting the exact Ollama-shaped
    // structure (not just message count) is what would fail if this
    // implementation were swapped to read from the OpenAI-shaped preview.
    const steps = [
      step({ kind: "system", content: "you are a helper" }),
      step({ kind: "user", content: "weather?" }),
      step({ kind: "tool_call", content: "", toolCall: { name: "get_weather", arguments: {} } }),
      step({ kind: "tool_result", content: "sunny", toolResult: { name: "get_weather" } }),
    ];
    const messages = toOllamaFilteredMessages(steps);
    expect(messages).toEqual([
      { role: "system", content: "you are a helper" },
      { role: "user", content: "weather?" },
      { role: "assistant", content: "" },
      { role: "tool", content: "sunny" },
    ]);
  });
});

describe("findLastUsageStep", () => {
  it("returns null when no step has ever reported usage", () => {
    const steps = [step({ kind: "user", content: "hi" }), step({ kind: "assistant", content: "hello" })];
    expect(findLastUsageStep(steps)).toBeNull();
  });

  it("returns the LAST usage-bearing assistant step's index and promptEvalCount", () => {
    const steps = [
      step({ kind: "user", content: "hi" }),
      step({ kind: "assistant", content: "hello", usage: { inputTokens: 12 } }),
      step({ kind: "user", content: "again" }),
      step({ kind: "assistant", content: "hi again", usage: { inputTokens: 30 } }),
    ];
    expect(findLastUsageStep(steps)).toEqual({ index: 3, promptEvalCount: 30 });
  });
});

describe("turnHasToolCall", () => {
  it("is false for a plain system+user+assistant turn", () => {
    const steps = [
      step({ kind: "system", content: "s" }),
      step({ kind: "user", content: "hi" }),
      step({ kind: "assistant", content: "hello", usage: { inputTokens: 5 } }),
    ];
    expect(turnHasToolCall(steps, 2)).toBe(false);
  });

  it("is true when a tool_call sits between the preceding user step and the usage-bearing assistant step", () => {
    const steps = [
      step({ kind: "user", content: "weather?" }),
      step({ kind: "tool_call", content: "" }),
      step({ kind: "tool_result", content: "sunny" }),
      step({ kind: "assistant", content: "It's sunny.", usage: { inputTokens: 40 } }),
    ];
    expect(turnHasToolCall(steps, 3)).toBe(true);
  });

  // The two branches below cover the shape ws-handler ACTUALLY persists:
  // it filters standalone tool_call steps out and folds them into the
  // assistant as toolCalls[] (architecture.md Implementation Constraint 4).
  // The legacy-shape cases above only occur in tour/example conversations.
  it("is true for the MERGED shape the server persists (assistant carrying toolCalls[])", () => {
    const steps = [
      step({ kind: "user", content: "weather?" }),
      step({ kind: "assistant", content: "", toolCalls: [{ name: "get_weather", arguments: {} }] }),
      step({ kind: "tool_result", content: "sunny" }),
      step({ kind: "assistant", content: "It's sunny.", usage: { inputTokens: 40 } }),
    ];
    expect(turnHasToolCall(steps, 3)).toBe(true);
  });

  it("is false for an assistant carrying an EMPTY toolCalls array", () => {
    const steps = [
      step({ kind: "user", content: "hi" }),
      step({ kind: "assistant", content: "hello", toolCalls: [] }),
      step({ kind: "assistant", content: "more", usage: { inputTokens: 5 } }),
    ];
    expect(turnHasToolCall(steps, 2)).toBe(false);
  });

  it("a MERGED-shape tool turn does not invalidate a LATER, tool-free turn", () => {
    const steps = [
      step({ kind: "user", content: "weather?" }),
      step({ kind: "assistant", content: "", toolCalls: [{ name: "get_weather", arguments: {} }] }),
      step({ kind: "tool_result", content: "sunny" }),
      step({ kind: "assistant", content: "It's sunny." }),
      step({ kind: "user", content: "thanks" }),
      step({ kind: "assistant", content: "you're welcome", usage: { inputTokens: 9 } }),
    ];
    expect(turnHasToolCall(steps, 5)).toBe(false);
  });

  it("an EARLIER turn's tool_call does not invalidate a LATER, tool-free turn", () => {
    const steps = [
      step({ kind: "user", content: "weather?" }),
      step({ kind: "tool_call", content: "" }),
      step({ kind: "tool_result", content: "sunny" }),
      step({ kind: "assistant", content: "It's sunny." }),
      step({ kind: "user", content: "thanks" }),
      step({ kind: "assistant", content: "you're welcome", usage: { inputTokens: 9 } }),
    ];
    expect(turnHasToolCall(steps, 5)).toBe(false);
  });
});

describe("useTokenizedMessages", () => {
  it("tokenizes each message's content and caches by (content, cacheKeySuffix)", async () => {
    const tokenizeText = vi.fn((text: string) => Promise.resolve(text.split(" ")));
    const messages = [{ role: "user" as const, content: "a b" }];
    const { result } = renderHook(() => useTokenizedMessages(messages, tokenizeText, true, "model-1"));

    expect(result.current.messages[0].tokens).toBeNull();
    await waitFor(() => expect(result.current.messages[0].tokens).toEqual(["a", "b"]));
    expect(tokenizeText).toHaveBeenCalledTimes(1);
    expect(result.current.failed).toBe(false);
  });

  it("does not tokenize while inactive", () => {
    const tokenizeText = vi.fn().mockResolvedValue([]);
    const messages = [{ role: "user" as const, content: "hi" }];
    renderHook(() => useTokenizedMessages(messages, tokenizeText, false));
    expect(tokenizeText).not.toHaveBeenCalled();
  });

  it("re-tokenizes when cacheKeySuffix (the model) changes even though content is unchanged (S3's invariant-computed-boundary-model-key discipline)", async () => {
    const tokenizeText = vi.fn((text: string) => Promise.resolve([`${text}-under-model`]));
    const messages = [{ role: "user" as const, content: "hi" }];
    const { result, rerender } = renderHook(
      ({ suffix }) => useTokenizedMessages(messages, tokenizeText, true, suffix),
      { initialProps: { suffix: "model-a" } }
    );
    await waitFor(() => expect(result.current.messages[0].tokens).not.toBeNull());
    expect(tokenizeText).toHaveBeenCalledTimes(1);

    rerender({ suffix: "model-b" });
    // Stale (model-a) result must not be served under the model-b key.
    expect(result.current.messages[0].tokens).toBeNull();
    await waitFor(() => expect(tokenizeText).toHaveBeenCalledTimes(2));
  });

  it("reports failed: true (and leaves tokens null) when the round trip rejects, without retrying (S4-F3)", async () => {
    const tokenizeText = vi.fn().mockRejectedValue(new Error("tokenize.error"));
    const messages = [{ role: "user" as const, content: "hi" }];
    const { result } = renderHook(() => useTokenizedMessages(messages, tokenizeText, true, "model-1"));

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.messages[0].tokens).toBeNull();
    expect(tokenizeText).toHaveBeenCalledTimes(1);
  });

  it("reports failed=false while inactive, so the failure notice cannot flash during the dialog's exit transition (S4-R2)", () => {
    const tokenizeText = vi.fn().mockResolvedValue(["hi"]);
    const messages = [{ role: "user" as const, content: "hi" }];
    // Inactive: `key` is null and `failedKey` starts null. A bare
    // `failedKey === key` reads true here, and MUI keeps a Dialog's children
    // mounted through its ~225ms exit transition with `open` already false.
    const { result } = renderHook(() => useTokenizedMessages(messages, tokenizeText, false, "model-1"));

    expect(result.current.failed).toBe(false);
    expect(tokenizeText).not.toHaveBeenCalled();
  });

  it("evicts a rejection from the shared cache so a later key change genuinely retries (S4-R1)", async () => {
    const cache = new Map();
    const tokenizeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("tokenize.error"))
      .mockResolvedValue(["hi"]);
    const messages = [{ role: "user" as const, content: "hi" }];
    const { result, rerender } = renderHook(
      ({ suffix }) => useTokenizedMessages(messages, tokenizeText, true, suffix, cache),
      { initialProps: { suffix: "model-1" } }
    );

    await waitFor(() => expect(result.current.failed).toBe(true));
    // A cached rejection would make the failure permanent for this
    // (model, content) pair for the cache's lifetime; eviction means the
    // entry is simply gone.
    expect(cache.size).toBe(0);

    rerender({ suffix: "model-2" });
    await waitFor(() => expect(result.current.messages[0].tokens).toEqual(["hi"]));
    expect(result.current.failed).toBe(false);
  });

  it("does not fire the tokenize round trip until COMPUTED_SOURCE_DEBOUNCE_MS has elapsed (S4-F2)", async () => {
    const tokenizeText = vi.fn().mockResolvedValue(["hi"]);
    const messages = [{ role: "user" as const, content: "hi" }];
    renderHook(() => useTokenizedMessages(messages, tokenizeText, true, "model-1"));

    expect(tokenizeText).not.toHaveBeenCalled();
    await waitFor(() => expect(tokenizeText).toHaveBeenCalledTimes(1));
  });

  it("reading tokenizeText through a ref keeps the fetch effect from re-firing when only its identity changes (S4-F2, mirrors useTokenBoundaries's S2-F2 fix)", async () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    let calls = 0;
    const { result, rerender } = renderHook(
      ({ fn }: { fn: (text: string) => Promise<string[]> }) => useTokenizedMessages(messages, fn, true, "model-1"),
      {
        initialProps: {
          fn: (text: string) => {
            calls++;
            return Promise.resolve([text]);
          },
        },
      }
    );

    await waitFor(() => expect(result.current.messages[0].tokens).toEqual(["hi"]));
    expect(calls).toBe(1);

    // A fresh lambda identity, `key`/`active` unchanged: must NOT
    // re-trigger the fetch effect (an inline-lambda caller would
    // otherwise re-fire it every render, unboundedly).
    rerender({
      fn: (text: string) => {
        calls++;
        return Promise.resolve([text]);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
  });

  it("shares tokenize round trips across instances via a caller-supplied TokenizeCache (S4-F5)", async () => {
    const tokenizeText = vi.fn((text: string) => Promise.resolve(text.split(" ")));
    const cache = new Map();
    const messagesA = [{ role: "user" as const, content: "a b" }, { role: "assistant" as const, content: "c" }];
    const messagesB = [{ role: "user" as const, content: "a b" }];

    const { result: resultA } = renderHook(() =>
      useTokenizedMessages(messagesA, tokenizeText, true, "model-1", cache)
    );
    const { result: resultB } = renderHook(() =>
      useTokenizedMessages(messagesB, tokenizeText, true, "model-1", cache)
    );

    await waitFor(() => expect(resultA.current.messages[0].tokens).toEqual(["a", "b"]));
    await waitFor(() => expect(resultB.current.messages[0].tokens).toEqual(["a", "b"]));
    // "a b" is shared by both lists; tokenizeText must be called once for
    // it (plus once for "c", which only messagesA has) — never twice for
    // the same content under the same cacheKeySuffix.
    expect(tokenizeText).toHaveBeenCalledTimes(2);
  });
});

describe("useReconciliation", () => {
  it("status 'none' when nothing in the conversation has ever reported usage", () => {
    const steps = [step({ kind: "user", content: "hi" })];
    const { result } = renderHook(() => useReconciliation(steps, vi.fn(), true));
    expect(result.current.status).toBe("none");
  });

  it("status 'unavailable' with a named reason for a tool-call turn (legacy standalone tool_call step, e.g. tour/example conversations), and never attempts a partial count", () => {
    const tokenizeText = vi.fn().mockResolvedValue(["x"]);
    const steps = [
      step({ kind: "user", content: "weather?" }),
      step({ kind: "tool_call", content: "" }),
      step({ kind: "tool_result", content: "sunny" }),
      step({ kind: "assistant", content: "It's sunny.", usage: { inputTokens: 40 } }),
    ];
    const { result } = renderHook(() => useReconciliation(steps, tokenizeText, true));
    expect(result.current).toEqual({ status: "unavailable", reason: RECONCILIATION_TOOL_CALL_REASON });
    expect(tokenizeText).not.toHaveBeenCalled();
  });

  it("status 'unavailable' with a named reason for a tool-call turn (merged shape the live server actually persists — ws-handler.ts folds tool_call steps into assistant.toolCalls[]), and never attempts a partial count", () => {
    const tokenizeText = vi.fn().mockResolvedValue(["x"]);
    const steps = [
      step({ kind: "user", content: "weather?" }),
      step({ kind: "assistant", content: "", toolCalls: [{ name: "get_weather", arguments: {} }] }),
      step({ kind: "tool_result", content: "sunny" }),
      step({ kind: "assistant", content: "It's sunny.", usage: { inputTokens: 40 } }),
    ];
    const { result } = renderHook(() => useReconciliation(steps, tokenizeText, true));
    expect(result.current).toEqual({ status: "unavailable", reason: RECONCILIATION_TOOL_CALL_REASON });
    expect(tokenizeText).not.toHaveBeenCalled();
  });

  it("computes contentTokenCount from steps[0..i), tokenized via toOllamaFilteredMessages, and labels the difference as chat-template overhead — never referencing requestJsonPreview", async () => {
    const tokenizeText = vi.fn((text: string) => Promise.resolve(text.split(" ")));
    const steps = [
      step({ kind: "system", content: "be terse" }), // 2 tokens
      step({ kind: "user", content: "hi there" }), // 2 tokens
      step({ kind: "assistant", content: "hello", usage: { inputTokens: 30 } }),
    ];
    const { result } = renderHook(() => useReconciliation(steps, tokenizeText, true));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toEqual({
      status: "ready",
      contentTokenCount: 4,
      promptEvalCount: 30,
      overhead: 26,
    });
    // The assistant step carrying usage is EXCLUDED (steps[0..i)) — its
    // content ("hello") must never be tokenized as part of the count.
    expect(tokenizeText).not.toHaveBeenCalledWith("hello");
  });

  it("exposes TEMPLATE_OVERHEAD_LABEL as the exact, non-alarming label text", () => {
    expect(TEMPLATE_OVERHEAD_LABEL).toBe("chat-template overhead");
    expect(TEMPLATE_OVERHEAD_LABEL.toLowerCase()).not.toMatch(/mismatch|error|warning/);
  });

  it("status 'error' with a named reason when the tokenize round trip fails, rather than staying 'pending' forever (S4-F3)", async () => {
    const tokenizeText = vi.fn().mockRejectedValue(new Error("tokenize.error"));
    const steps = [
      step({ kind: "system", content: "be terse" }),
      step({ kind: "user", content: "hi there" }),
      step({ kind: "assistant", content: "hello", usage: { inputTokens: 30 } }),
    ];
    const { result } = renderHook(() => useReconciliation(steps, tokenizeText, true));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.reason).toBe(RECONCILIATION_FAILED_REASON);
  });
});
