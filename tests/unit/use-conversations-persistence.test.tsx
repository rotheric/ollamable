/**
 * Persistence-guard tests for `useConversations`, targeting mutation-gate
 * residuals that the existing suite doesn't observe:
 *
 *   - `if (tools.length === 0) return;` tool re-sync guard (line 61).
 *   - `if (conversations.length === 0) return;` save guard (line 68).
 *   - `if (selectedConversationId) saveSelectedConversationId(...)` guard (line 76).
 *   - `currentSelectedId !== id` branch in deleteConversation (line 123).
 *   - `remaining[0]?.id ?? ""` fallback when the selected one is deleted (line 127).
 *
 * The observation surface is the browser's localStorage (where the hook
 * writes) plus the hook's own return value. We never spy on
 * implementation; the hook's write-through contract is externally visible.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Conversation, OllamaModel, ToolDefinition } from "@/src/types/chat";
import {
  CONVERSATION_ORDER_KEY,
  SELECTED_KEY,
  STORAGE_KEY,
  createConversation,
  createStep,
} from "@/src/lib/chat";
import { useConversations } from "@/src/lib/use-conversations";

function conversation(id: string, options: { withUserMessage?: boolean } = {}): Conversation {
  const base = createConversation("qwen3:latest", [], "ollama");
  const steps = options.withUserMessage === false ? base.steps : [...base.steps, createStep("user", "User", `hi ${id}`)];
  return { ...base, id, title: id, steps };
}

const curl: ToolDefinition = { id: "curl", name: "curl", description: "Fetch", inputSchema: "{}" };
const web: ToolDefinition = { id: "web-search", name: "web_search", description: "Search", inputSchema: "{}" };
// Stable module-level arrays — a fresh literal per render would re-fire the `[tools]` effect forever.
const NO_TOOLS: ToolDefinition[] = [];
const CURL_ONLY: ToolDefinition[] = [curl];
const CURL_AND_WEB: ToolDefinition[] = [curl, web];

beforeEach(() => {
  window.localStorage.clear();
});

describe("useConversations persistence guards", () => {
  it("does not overwrite STORAGE_KEY with an empty list when the sole conversation is deleted (guard at line 68)", () => {
    const only = conversation("only");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([only]));

    const { result } = renderHook(() => useConversations(CURL_ONLY));
    // After init+save, storage reflects the one conv (ensureConversationTools may re-save with curl merged in).
    const beforeDelete = window.localStorage.getItem(STORAGE_KEY);
    expect(beforeDelete).not.toBeNull();
    const beforeParsed = JSON.parse(beforeDelete!) as Conversation[];
    expect(beforeParsed).toHaveLength(1);

    act(() => result.current.deleteConversation(only.id));

    const afterDelete = window.localStorage.getItem(STORAGE_KEY);
    // The guard keeps the save-effect from writing "[]" — the storage still carries the pre-delete snapshot.
    expect(afterDelete).toBe(beforeDelete);
    expect(afterDelete).not.toBe("[]");
  });

  it("writes conversations through to STORAGE_KEY after a conversation is added", () => {
    const { result } = renderHook(() => useConversations(CURL_ONLY));
    // Hook's fallback already wrote one conversation. Capture that as the baseline.
    const baseline = window.localStorage.getItem(STORAGE_KEY);
    expect(baseline).not.toBeNull();
    const baselineIds = (JSON.parse(baseline!) as Conversation[]).map((c) => c.id);

    act(() => result.current.addConversation({ name: "qwen3:latest", provider: "ollama" } as OllamaModel));

    const written = window.localStorage.getItem(STORAGE_KEY);
    const parsed = JSON.parse(written!) as Conversation[];
    // The added conversation lands first, baseline follows.
    expect(parsed.length).toBe(baselineIds.length + 1);
    expect(parsed[0].model).toBe("qwen3:latest");
    expect(parsed.map((c) => c.id)).toEqual([parsed[0].id, ...baselineIds]);
  });

  it("re-syncs tools onto loaded conversations only after the tools list arrives (non-empty)", () => {
    const seeded = conversation("a");
    // Seeded conversation currently has no tools, no activeToolIds.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([seeded]));

    const { result, rerender } = renderHook(({ tools }: { tools: ToolDefinition[] }) => useConversations(tools), {
      initialProps: { tools: NO_TOOLS },
    });

    // Loaded, but tools empty: ensureConversationTools must not run — the
    // conversation's availableTools stays empty, not the empty tools arg.
    expect(result.current.conversations[0].availableTools).toEqual([]);

    rerender({ tools: CURL_AND_WEB });

    // Now re-synced — tools visible on the conversation.
    expect(result.current.conversations[0].availableTools.map((t) => t.id).sort()).toEqual([curl.id, web.id].sort());
  });

  it("persists selectedConversationId to storage when it is set to a non-empty id", () => {
    const { result } = renderHook(() => useConversations(CURL_ONLY));

    act(() => result.current.addConversation({ name: "qwen3:latest", provider: "ollama" }));
    const id = result.current.conversations[0].id;

    expect(window.localStorage.getItem(SELECTED_KEY)).toBe(id);
  });

  it("does not remove SELECTED_KEY when the sole selected conversation is deleted (guard at line 76 keeps '' from being flushed)", () => {
    const only = conversation("only");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([only]));
    window.localStorage.setItem(SELECTED_KEY, only.id);

    const { result } = renderHook(() => useConversations(CURL_ONLY));
    expect(window.localStorage.getItem(SELECTED_KEY)).toBe(only.id);

    act(() => result.current.deleteConversation(only.id));

    // selectedConversationId is now "" in state, but the save-effect's `if (selectedConversationId)`
    // guard keeps it from writing/removing — the stored id remains at its pre-delete value.
    expect(result.current.selectedConversationId).toBe("");
    expect(window.localStorage.getItem(SELECTED_KEY)).toBe(only.id);
  });

  it("deleting a non-selected conversation leaves the selection unchanged", () => {
    const a = conversation("a");
    const b = conversation("b");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([a, b]));
    window.localStorage.setItem(SELECTED_KEY, a.id);

    const { result } = renderHook(() => useConversations(CURL_ONLY));
    expect(result.current.selectedConversationId).toBe(a.id);

    act(() => result.current.deleteConversation(b.id));

    expect(result.current.selectedConversationId).toBe(a.id);
    expect(result.current.conversations.map((c) => c.id)).toEqual([a.id]);
  });

  it("deleting the selected conversation falls back to the first remaining (if any)", () => {
    const a = conversation("a");
    const b = conversation("b");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([a, b]));
    window.localStorage.setItem(SELECTED_KEY, a.id);

    const { result } = renderHook(() => useConversations(CURL_ONLY));
    expect(result.current.selectedConversationId).toBe(a.id);

    act(() => result.current.deleteConversation(a.id));

    expect(result.current.selectedConversationId).toBe(b.id);
  });

  it("deleting the only (and selected) conversation sets selection to the empty string", () => {
    const a = conversation("a");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([a]));
    window.localStorage.setItem(SELECTED_KEY, a.id);

    const { result } = renderHook(() => useConversations(CURL_ONLY));
    expect(result.current.selectedConversationId).toBe(a.id);

    act(() => result.current.deleteConversation(a.id));

    expect(result.current.selectedConversationId).toBe("");
    expect(result.current.conversations).toEqual([]);
  });

  it("deleting a conversation drops it from the saved order", () => {
    const a = conversation("a");
    const b = conversation("b");
    const c = conversation("c");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([a, b, c]));
    window.localStorage.setItem(CONVERSATION_ORDER_KEY, JSON.stringify([a.id, b.id, c.id]));

    const { result } = renderHook(() => useConversations(CURL_ONLY));

    act(() => result.current.deleteConversation(b.id));

    const stored = JSON.parse(window.localStorage.getItem(CONVERSATION_ORDER_KEY) ?? "[]") as string[];
    expect(stored).toEqual([a.id, c.id]);
  });

  it("addForkedConversation inserts the fork at the top and selects it, next to a sibling", () => {
    const a = conversation("a");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([a]));

    const { result } = renderHook(() => useConversations(CURL_ONLY));

    const fork: Conversation = { ...conversation("fork"), forkedFrom: { conversationId: a.id, stepId: "tc-1" } };
    act(() => result.current.addForkedConversation(fork));

    expect(result.current.conversations[0].id).toBe(fork.id);
    expect(result.current.selectedConversationId).toBe(fork.id);
  });
});
