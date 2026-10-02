import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Conversation, ToolDefinition } from "@/src/types/chat";
import { CONVERSATION_ORDER_KEY, createConversation, createStep, SELECTED_KEY, STORAGE_KEY } from "@/src/lib/chat";
import { orderVisibleConversations, useConversations } from "@/src/lib/use-conversations";

function conversation(id: string, options: { withUserMessage?: boolean } = {}): Conversation {
  const base = createConversation("qwen3:latest", [], "ollama");
  const steps = options.withUserMessage === false ? base.steps : [...base.steps, createStep("user", "User", `hello from ${id}`)];
  return { ...base, id, title: id, steps };
}

function seed(conversations: Conversation[], extra: { selected?: string; order?: string[] } = {}) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  if (extra.selected) window.localStorage.setItem(SELECTED_KEY, extra.selected);
  if (extra.order) window.localStorage.setItem(CONVERSATION_ORDER_KEY, JSON.stringify(extra.order));
}

function storedIds(): string[] {
  return (JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as Conversation[]).map((c) => c.id);
}

const NO_TOOLS: ToolDefinition[] = [];
const curl: ToolDefinition = { id: "curl", name: "curl", description: "Fetch a URL", inputSchema: "{}" };
// Stable identities, like the state the hook receives in the app: a fresh array per render would re-sync forever.
const CURL_ONLY: ToolDefinition[] = [curl];

beforeEach(() => {
  window.localStorage.clear();
});

describe("orderVisibleConversations", () => {
  it("hides conversations that have no user message yet", () => {
    const empty = conversation("empty", { withUserMessage: false });
    const started = conversation("started");
    expect(orderVisibleConversations([empty, started], null)).toEqual([started]);
  });

  it("keeps list order when no order was saved", () => {
    const [a, b] = [conversation("a"), conversation("b")];
    expect(orderVisibleConversations([a, b], null)).toEqual([a, b]);
  });

  it("follows the saved order and ignores ids it no longer knows", () => {
    const [a, b, c] = [conversation("a"), conversation("b"), conversation("c")];
    expect(orderVisibleConversations([a, b, c], ["c", "gone", "a", "b"]).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("puts conversations missing from the saved order on top", () => {
    const [a, b, fresh] = [conversation("a"), conversation("b"), conversation("fresh")];
    expect(orderVisibleConversations([a, b, fresh], ["b", "a"]).map((x) => x.id)).toEqual(["fresh", "b", "a"]);
  });
});

describe("useConversations", () => {
  it("starts a first conversation when nothing is stored, and selects it", () => {
    const { result } = renderHook(() => useConversations(NO_TOOLS));

    expect(result.current.conversations).toHaveLength(1);
    expect(result.current.selectedConversation).toBe(result.current.conversations[0]);
    expect(result.current.conversationOrder).toBeNull();
  });

  it("restores stored conversations, selection and order", () => {
    seed([conversation("a"), conversation("b")], { selected: "b", order: ["b", "a"] });

    const { result } = renderHook(() => useConversations(NO_TOOLS));

    expect(result.current.conversations.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.current.selectedConversationId).toBe("b");
    expect(result.current.selectedConversation?.id).toBe("b");
    expect(result.current.conversationOrder).toEqual(["b", "a"]);
  });

  it("selects the first conversation when the stored selection no longer exists", () => {
    seed([conversation("a"), conversation("b")], { selected: "deleted-elsewhere" });

    const { result } = renderHook(() => useConversations(NO_TOOLS));

    expect(result.current.selectedConversationId).toBe("a");
    expect(window.localStorage.getItem(SELECTED_KEY)).toBe("a");
  });

  it("updateConversation changes only the addressed conversation and persists it", () => {
    seed([conversation("a"), conversation("b")], { selected: "a" });
    const { result } = renderHook(() => useConversations(NO_TOOLS));
    const untouched = result.current.conversations[1];

    act(() => result.current.updateConversation("a", (c) => ({ ...c, title: "renamed" })));

    expect(result.current.conversations[0].title).toBe("renamed");
    expect(result.current.conversations[1]).toBe(untouched);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!) as Conversation[];
    expect(stored.map((c) => c.title)).toEqual(["renamed", "b"]);
  });

  it("addConversation puts a new conversation first, selects it and gives it the model and current tools", () => {
    seed([conversation("a")], { selected: "a" });
    const { result } = renderHook(() => useConversations(CURL_ONLY));

    act(() => result.current.addConversation({ name: "llama3.2:latest", provider: "remote" }));

    const [added, existing] = result.current.conversations;
    expect(existing.id).toBe("a");
    expect(added.model).toBe("llama3.2:latest");
    expect(added.provider).toBe("remote");
    expect(added.availableTools).toEqual([curl]);
    expect(added.activeToolIds).toEqual([]);
    expect(result.current.selectedConversationId).toBe(added.id);
    expect(window.localStorage.getItem(SELECTED_KEY)).toBe(added.id);
  });

  it("addConversation falls back to the first fallback model when discovery offers none", () => {
    const { result } = renderHook(() => useConversations(NO_TOOLS));

    act(() => result.current.addConversation(undefined));

    expect(result.current.conversations[0].model).toBe("qwen3:latest");
    expect(result.current.conversations[0].provider).toBeUndefined();
  });

  it("deleting the selected conversation selects the first remaining one", () => {
    seed([conversation("a"), conversation("b"), conversation("c")], { selected: "b" });
    const { result } = renderHook(() => useConversations(NO_TOOLS));

    act(() => result.current.deleteConversation("b"));

    expect(result.current.conversations.map((c) => c.id)).toEqual(["a", "c"]);
    expect(result.current.selectedConversationId).toBe("a");
    expect(storedIds()).toEqual(["a", "c"]);
  });

  it("deleting another conversation keeps the selection", () => {
    seed([conversation("a"), conversation("b"), conversation("c")], { selected: "c" });
    const { result } = renderHook(() => useConversations(NO_TOOLS));

    act(() => result.current.deleteConversation("a"));

    expect(result.current.selectedConversationId).toBe("c");
    expect(window.localStorage.getItem(SELECTED_KEY)).toBe("c");
    expect(storedIds()).toEqual(["b", "c"]);
  });

  it("deleting a conversation removes it from the saved order", () => {
    seed([conversation("a"), conversation("b")], { selected: "a", order: ["b", "a"] });
    const { result } = renderHook(() => useConversations(NO_TOOLS));

    act(() => result.current.deleteConversation("b"));

    expect(result.current.conversationOrder).toEqual(["a"]);
    expect(JSON.parse(window.localStorage.getItem(CONVERSATION_ORDER_KEY)!)).toEqual(["a"]);
  });

  it("reorderConversations stores the new order", () => {
    seed([conversation("a"), conversation("b")], { selected: "a" });
    const { result } = renderHook(() => useConversations(NO_TOOLS));

    act(() => result.current.reorderConversations(["b", "a"]));

    expect(result.current.conversationOrder).toEqual(["b", "a"]);
    expect(JSON.parse(window.localStorage.getItem(CONVERSATION_ORDER_KEY)!)).toEqual(["b", "a"]);
  });

  it("offers newly discovered tools to existing conversations without enabling them", () => {
    seed([conversation("a")], { selected: "a" });
    const { result, rerender } = renderHook(({ tools }) => useConversations(tools), {
      initialProps: { tools: NO_TOOLS },
    });
    expect(result.current.conversations[0].availableTools).toEqual([]);

    rerender({ tools: CURL_ONLY });

    expect(result.current.conversations[0].availableTools).toEqual([curl]);
    expect(result.current.conversations[0].activeToolIds).toEqual([]);
  });

  it("keeps a conversation's enabled tools when the tool list is re-synced", () => {
    const withCurl = { ...conversation("a"), availableTools: [curl], activeToolIds: ["curl"] };
    seed([withCurl], { selected: "a" });
    const other: ToolDefinition = { id: "web-search", name: "web_search", description: "Search", inputSchema: "{}" };

    const { result, rerender } = renderHook(({ tools }) => useConversations(tools), {
      initialProps: { tools: NO_TOOLS },
    });
    rerender({ tools: [curl, other] });

    expect(result.current.conversations[0].availableTools.map((t) => t.id)).toEqual(["curl", "web-search"]);
    expect(result.current.conversations[0].activeToolIds).toEqual(["curl"]);
  });
});
