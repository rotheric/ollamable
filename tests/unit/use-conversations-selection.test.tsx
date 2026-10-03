/**
 * `useConversations` selection persistence and tool freshness: the stored
 * selection only ever names a conversation that exists, an empty stored list
 * loads without a selection, and a conversation created after the tool list
 * changed gets the current tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Conversation, ToolDefinition } from "@/src/types/chat";
import { SELECTED_KEY, STORAGE_KEY, createConversation, createStep } from "@/src/lib/chat";
import { useConversations } from "@/src/lib/use-conversations";

const curl: ToolDefinition = { id: "curl", name: "curl", description: "Fetch", inputSchema: "{}" };
const web: ToolDefinition = { id: "web-search", name: "web_search", description: "Search", inputSchema: "{}" };
const CURL_ONLY: ToolDefinition[] = [curl];
const CURL_AND_WEB: ToolDefinition[] = [curl, web];

function conversation(id: string): Conversation {
  const c = createConversation("qwen3:latest", [], "ollama");
  return { ...c, id, steps: [...c.steps, createStep("user", "User", `hi ${id}`)] };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("selection persistence", () => {
  it("only ever stores the id of a loaded conversation", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([conversation("a"), conversation("b")]));
    const setItem = vi.spyOn(window.localStorage, "setItem");
    renderHook(() => useConversations(CURL_ONLY));
    const selections = setItem.mock.calls.filter(([key]) => key === SELECTED_KEY).map(([, value]) => value);
    expect(selections.length).toBeGreaterThan(0);
    for (const value of selections) expect(["a", "b"]).toContain(value);
  });

  it("loads an empty stored list without a selection and without storing one", () => {
    window.localStorage.setItem(STORAGE_KEY, "[]");
    const setItem = vi.spyOn(window.localStorage, "setItem");
    const { result } = renderHook(() => useConversations(CURL_ONLY));
    expect(result.current.conversations).toEqual([]);
    expect(result.current.selectedConversationId).toBe("");
    expect(result.current.selectedConversation).toBeNull();
    expect(setItem.mock.calls.filter(([key]) => key === SELECTED_KEY)).toEqual([]);
  });
});

describe("tool freshness", () => {
  it("creates new conversations with the tools current at creation time", () => {
    const { result, rerender } = renderHook(({ tools }: { tools: ToolDefinition[] }) => useConversations(tools), {
      initialProps: { tools: CURL_ONLY },
    });
    rerender({ tools: CURL_AND_WEB });
    act(() => result.current.addConversation(undefined));
    expect(result.current.conversations[0].availableTools.map((t) => t.id)).toEqual([curl.id, web.id]);
  });
});
