import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConversations, loadConversationOrder, loadSelectedConversationId, loadSidebarState,
  saveConversations, saveConversationOrder, saveSelectedConversationId, saveSidebarState, createConversation,
  STORAGE_KEY, SELECTED_KEY, CONVERSATION_ORDER_KEY, SIDEBAR_STATE_KEY } from "@/src/lib/chat";
import { persistenceStatus, readStorage, writeStorage } from "@/src/lib/persistence";

const keys = [STORAGE_KEY, SELECTED_KEY, CONVERSATION_ORDER_KEY, SIDEBAR_STATE_KEY];
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of keys) { readStorage(key); writeStorage(key, ""); }
});

describe("persistent storage failures", () => {
  it.each(["QuotaExceededError", "SecurityError"])("safely reports %s for every writer and retains old data", (name) => {
    for (const key of keys) localStorage.setItem(key, "original");
    const sidebar = loadSidebarState();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("Unavailable", name); });
    vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new DOMException("Unavailable", name); });
    expect(() => {
      saveConversations([createConversation("model", [])]);
      saveSidebarState(sidebar);
      saveConversationOrder(["new"]);
      saveSelectedConversationId("new");
      saveSelectedConversationId("");
    }).not.toThrow();
    for (const key of keys) {
      expect(persistenceStatus()).toContain(`write:${key}`);
      expect(localStorage.getItem(key)).toBe("original");
    }
  });

  it("reports unreadable storage and prevents defaults overwriting unknown saved values", () => {
    for (const key of keys) localStorage.setItem(key, "original");
    const getter = vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new DOMException("Unavailable", "SecurityError"); });
    const setter = vi.spyOn(localStorage, "setItem");
    expect(() => {
      const conversations = loadConversations([]);
      const sidebar = loadSidebarState();
      expect(loadConversationOrder()).toBeNull();
      expect(loadSelectedConversationId()).toBeNull();
      saveConversations(conversations);
      saveSidebarState(sidebar);
      saveConversationOrder([]);
      saveSelectedConversationId("");
    }).not.toThrow();
    expect(setter).not.toHaveBeenCalled();
    getter.mockRestore();
    for (const key of keys) expect(localStorage.getItem(key)).toBe("original");
  });

  it("clears a write failure only when that same key saves successfully", () => {
    const setter = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    saveSelectedConversationId("selected");
    setter.mockRestore();
    saveConversationOrder([]);
    expect(persistenceStatus()).toContain(`write:${SELECTED_KEY}`);
    saveSelectedConversationId("selected");
    expect(persistenceStatus()).not.toContain(`write:${SELECTED_KEY}`);
  });

  it("recovers genuine partial prose as interrupted and discards provisional tool calls on reload", () => {
    const conversation = createConversation("model", []);
    conversation.steps.push(
      { id: "stream-answer", kind: "assistant", title: "Assistant", content: "Partial answer", createdAt: conversation.createdAt, contentTokens: ["Partial", " answer"] },
      { id: "stream-call", kind: "tool_call", title: "Tool Call", content: "", createdAt: conversation.createdAt, toolCall: { name: "curl", arguments: {} } },
    );
    saveConversations([conversation]);
    const steps = loadConversations([])[0].steps;
    expect(steps.find((s) => s.kind === "assistant")).toMatchObject({ id: "interrupted-answer", content: "Partial answer", interrupted: true, contentTokens: ["Partial", " answer"] });
    expect(steps.some((s) => s.kind === "tool_call")).toBe(false);
    expect(steps.some((s) => s.id.startsWith("stream-"))).toBe(false);
  });
});
