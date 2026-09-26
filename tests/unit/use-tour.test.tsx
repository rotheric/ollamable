import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { ACTIONS, EVENTS, STATUS, type EventData } from "react-joyride";
import { createConversation, loadSidebarState, type SidebarState } from "@/src/lib/chat";
import { useTour, TOUR_SESSION_KEY } from "@/src/lib/use-tour";
import { TOUR_COMPLETED_KEY, TOUR_STEP_KEY } from "@/src/lib/tour-data";
import type { Conversation } from "@/src/types/chat";

function useHarness(initialSidebar: SidebarState) {
  const [conversations, setConversations] = useState(() => [createConversation("qwen3:latest", [])]);
  const [selectedConversationId, setSelectedConversationId] = useState(conversations[0].id);
  const [order, setConversationOrder] = useState<string[] | null>([conversations[0].id]);
  const [sidebarState, setSidebarState] = useState(initialSidebar);
  const tour = useTour({ conversations, setConversations, selectedConversationId, setSelectedConversationId,
    setConversationOrder, sidebarState, setSidebarState, tools: [], models: [{ name: "qwen3:latest" }] });
  return { ...tour, conversations, setConversations, selectedConversationId, sidebarState, order };
}

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("tour lifecycle ownership", () => {
  it.each([false, true])("auto-starts exactly once with Strict Mode=%s and restores original sidebars", (strict) => {
    const sidebar = { ...loadSidebarState(), sidebarOpen: false, rightSidebarOpen: true, tempSectionOpen: true };
    const { result, unmount } = renderHook(() => useHarness(sidebar), { wrapper: strict ? StrictMode : undefined });
    const original = result.current.selectedConversationId;
    act(() => vi.advanceTimersByTime(499));
    expect(result.current.tourRun).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.tourRun).toBe(true);
    expect(result.current.conversations.filter((c) => c._tourExample)).toHaveLength(1);
    act(() => result.current.finishTour());
    expect(result.current.sidebarState).toEqual(sidebar);
    expect(result.current.selectedConversationId).toBe(original);
    expect(result.current.conversations.map((c) => c.id)).toEqual([original]);
    expect(result.current.order).toEqual([original]);
    expect(localStorage.getItem(TOUR_COMPLETED_KEY)).toBe("true");
    expect(localStorage.getItem(TOUR_SESSION_KEY)).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["edit", "send", "title"])("keeps a %s modification and removes its example marker", (mutation) => {
    localStorage.setItem(TOUR_COMPLETED_KEY, "true");
    const { result } = renderHook(() => useHarness(loadSidebarState()));
    act(() => result.current.handleStartTour());
    const example = result.current.selectedConversationId;
    act(() => result.current.setConversations((current) => current.map((c): Conversation => {
      if (c.id !== example) return c;
      if (mutation === "title") return { ...c, title: "My research" };
      if (mutation === "edit") return { ...c, steps: c.steps.map((step) => step.kind === "user" ? { ...step, content: "My edited prompt" } : step) };
      return { ...c, steps: [...c.steps, { id: "new-user", kind: "user", title: "User", content: "Follow-up", createdAt: c.createdAt }] };
    })));
    act(() => result.current.finishTour());
    const retained = result.current.conversations.find((c) => c.id === example);
    expect(retained).toBeDefined();
    expect(retained).not.toHaveProperty("_tourExample");
    expect(retained).not.toHaveProperty("_tourSeed");
    expect(result.current.selectedConversationId).toBe(example);
  });

  it("restores the original sidebar snapshot after a resumed session", () => {
    const original = { ...loadSidebarState(), sidebarOpen: false, rightSidebarOpen: true };
    localStorage.setItem(TOUR_SESSION_KEY, JSON.stringify({ sidebar: original, selectedId: "old" }));
    localStorage.setItem(TOUR_STEP_KEY, "8");
    const { result } = renderHook(() => useHarness(loadSidebarState()));
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.tourStepIndex).toBe(8);
    expect(result.current.sidebarState.tempSectionOpen).toBe(true);
    act(() => result.current.finishTour());
    expect(result.current.sidebarState).toEqual(original);
  });

  it("cancels delayed transitions on skip and does not write a new resume step later", () => {
    const { result, unmount } = renderHook(() => useHarness(loadSidebarState()));
    act(() => vi.advanceTimersByTime(500));
    act(() => result.current.handleJoyrideEvent({ action: ACTIONS.NEXT, index: 6, type: EVENTS.STEP_AFTER, status: STATUS.RUNNING } as EventData));
    act(() => result.current.finishTour());
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.tourStepIndex).toBe(0);
    expect(localStorage.getItem(TOUR_STEP_KEY)).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels automatic startup when unmounted before its timer fires", () => {
    const { unmount } = renderHook(() => useHarness(loadSidebarState()), { wrapper: StrictMode });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(1000));
    expect(localStorage.getItem(TOUR_SESSION_KEY)).toBeNull();
  });
});
