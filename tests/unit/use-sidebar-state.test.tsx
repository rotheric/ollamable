import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ConversationStep, StepKind } from "@/src/types/chat";
import { SIDEBAR_STATE_KEY, type SidebarState } from "@/src/lib/chat";
import { useSidebarState } from "@/src/lib/use-sidebar-state";

function stored(): SidebarState {
  return JSON.parse(window.localStorage.getItem(SIDEBAR_STATE_KEY) ?? "null") as SidebarState;
}

function step(kind: StepKind): ConversationStep {
  return { id: kind, kind, title: kind, content: "", createdAt: "2026-01-01T00:00:00.000Z" };
}

const RIGHT_SECTIONS = [
  "modelSectionOpen",
  "reasoningEffortSectionOpen",
  "tempSectionOpen",
  "maxTokensSectionOpen",
  "budgetSectionOpen",
  "toolsSectionOpen",
  "clientSectionOpen",
] as const;

function openSections(state: SidebarState): string[] {
  return RIGHT_SECTIONS.filter((key) => state[key]);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("useSidebarState", () => {
  it("starts from the defaults when nothing is stored", () => {
    const { result } = renderHook(() => useSidebarState());

    expect(result.current.sidebarState.sidebarOpen).toBe(true);
    expect(result.current.sidebarState.rightSidebarOpen).toBe(false);
    expect(result.current.sidebarState.renderMarkdown).toBe(true);
    expect(openSections(result.current.sidebarState)).toEqual([]);
  });

  it("restores stored preferences on mount, filling fields the stored record predates", () => {
    window.localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify({ sidebarOpen: false, showTokens: true }));

    const { result } = renderHook(() => useSidebarState());

    expect(result.current.sidebarState.sidebarOpen).toBe(false);
    expect(result.current.sidebarState.showTokens).toBe(true);
    expect(result.current.sidebarState.renderMarkdown).toBe(true);
    expect(result.current.sidebarState.subsections).toEqual({});
  });

  it("updateSidebar merges a patch and persists the result", () => {
    const { result } = renderHook(() => useSidebarState());

    act(() => result.current.updateSidebar({ showTokens: true, sidebarOpen: false }));

    expect(result.current.sidebarState.showTokens).toBe(true);
    expect(result.current.sidebarState.sidebarOpen).toBe(false);
    expect(result.current.sidebarState.renderMarkdown).toBe(true);
    expect(stored()).toEqual(result.current.sidebarState);
  });

  it("toggleRightSection keeps at most one section open and closes a section toggled twice", () => {
    const { result } = renderHook(() => useSidebarState());

    act(() => result.current.toggleRightSection("tempSectionOpen"));
    expect(openSections(result.current.sidebarState)).toEqual(["tempSectionOpen"]);

    act(() => result.current.toggleRightSection("toolsSectionOpen"));
    expect(openSections(result.current.sidebarState)).toEqual(["toolsSectionOpen"]);

    act(() => result.current.toggleRightSection("toolsSectionOpen"));
    expect(openSections(result.current.sidebarState)).toEqual([]);
    expect(openSections(stored())).toEqual([]);
  });

  it("toggleRightSection does not open or close the sidebar itself", () => {
    const { result } = renderHook(() => useSidebarState());

    act(() => result.current.toggleRightSection("modelSectionOpen"));

    expect(result.current.sidebarState.rightSidebarOpen).toBe(false);
  });

  it("openRightSection opens the sidebar on exactly that section", () => {
    const { result } = renderHook(() => useSidebarState());
    act(() => result.current.toggleRightSection("clientSectionOpen"));

    act(() => result.current.openRightSection("tempSectionOpen"));

    expect(result.current.sidebarState.rightSidebarOpen).toBe(true);
    expect(openSections(result.current.sidebarState)).toEqual(["tempSectionOpen"]);
    expect(stored()).toEqual(result.current.sidebarState);
  });

  it("openRightSection keeps an already open section open rather than toggling it", () => {
    const { result } = renderHook(() => useSidebarState());

    act(() => result.current.openRightSection("tempSectionOpen"));
    act(() => result.current.openRightSection("tempSectionOpen"));

    expect(openSections(result.current.sidebarState)).toEqual(["tempSectionOpen"]);
  });

  it("openRightSection can expand a subsection without closing the others", () => {
    const { result } = renderHook(() => useSidebarState());
    act(() => result.current.toggleSubsection("tools-builtin"));

    act(() => result.current.openRightSection("modelSectionOpen", "model-Ollama"));

    expect(result.current.isSubsectionOpen("model-Ollama")).toBe(true);
    expect(result.current.isSubsectionOpen("tools-builtin")).toBe(true);
  });

  it("toggleSubsection closes the other subsections when opening one, and only itself when closing", () => {
    const { result } = renderHook(() => useSidebarState());

    act(() => result.current.toggleSubsection("model-Ollama"));
    expect(result.current.isSubsectionOpen("model-Ollama")).toBe(true);

    act(() => result.current.toggleSubsection("model-MiniMax"));
    expect(result.current.isSubsectionOpen("model-Ollama")).toBe(false);
    expect(result.current.isSubsectionOpen("model-MiniMax")).toBe(true);

    act(() => result.current.toggleSubsection("model-MiniMax"));
    expect(result.current.isSubsectionOpen("model-MiniMax")).toBe(false);
    expect(stored().subsections).toEqual({ "model-Ollama": false, "model-MiniMax": false });
  });

  it("treats a subsection it has never seen as closed", () => {
    const { result } = renderHook(() => useSidebarState());
    expect(result.current.isSubsectionOpen("tools-mcp-playwright")).toBe(false);
  });

  it("revealToolsSubsection opens the tools section and subsection without closing what is open", () => {
    const { result } = renderHook(() => useSidebarState());
    act(() => result.current.toggleRightSection("modelSectionOpen"));
    act(() => result.current.toggleSubsection("model-Ollama"));

    act(() => result.current.revealToolsSubsection("tools-mcp-playwright"));

    expect(result.current.sidebarState.rightSidebarOpen).toBe(true);
    expect(openSections(result.current.sidebarState)).toEqual(["modelSectionOpen", "toolsSectionOpen"]);
    expect(result.current.isSubsectionOpen("tools-mcp-playwright")).toBe(true);
    expect(result.current.isSubsectionOpen("model-Ollama")).toBe(true);
    expect(stored()).toEqual(result.current.sidebarState);
  });

  describe("defaultExpanded", () => {
    it("expands everything except tool call requests under the default preferences", () => {
      const { result } = renderHook(() => useSidebarState());
      const expanded = (kind: StepKind) => result.current.defaultExpanded(step(kind));

      expect(expanded("user")).toBe(true);
      expect(expanded("assistant")).toBe(true);
      expect(expanded("reasoning")).toBe(true);
      expect(expanded("tool_result")).toBe(true);
      expect(expanded("meta")).toBe(true);
      expect(expanded("tool_call")).toBe(false);
    });

    it.each([
      ["collapseReasoning", "reasoning"],
      ["collapseToolCalls", "tool_result"],
      ["collapseServerMessages", "meta"],
    ] as const)("%s collapses new %s steps and nothing else", (preference, kind) => {
      const { result } = renderHook(() => useSidebarState());

      act(() => result.current.updateSidebar({ [preference]: true }));

      expect(result.current.defaultExpanded(step(kind))).toBe(false);
      expect(result.current.defaultExpanded(step("assistant"))).toBe(true);
      expect(result.current.defaultExpanded(step("user"))).toBe(true);
    });

    it("turning collapseTools off expands tool call requests", () => {
      const { result } = renderHook(() => useSidebarState());

      act(() => result.current.updateSidebar({ collapseTools: false }));

      expect(result.current.defaultExpanded(step("tool_call"))).toBe(true);
    });

    it("keeps one function identity while reading the latest preferences", () => {
      const { result } = renderHook(() => useSidebarState());
      const before = result.current.defaultExpanded;

      act(() => result.current.updateSidebar({ collapseReasoning: true }));

      // A generation started before the change must see the new preference.
      expect(result.current.defaultExpanded).toBe(before);
      expect(before(step("reasoning"))).toBe(false);
    });
  });
});
