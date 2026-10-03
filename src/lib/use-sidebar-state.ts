"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SIDEBAR_STATE, loadSidebarState, saveSidebarState, type SidebarState } from "@/src/lib/chat";
import { recordRuntimeWindow, type ResolvedContextWindow } from "@/src/lib/context-window";
import type { ConversationStep } from "@/src/types/chat";

export type RightSectionKey =
  | "modelSectionOpen"
  | "reasoningEffortSectionOpen"
  | "tempSectionOpen"
  | "maxTokensSectionOpen"
  | "budgetSectionOpen"
  | "toolsSectionOpen"
  | "clientSectionOpen";

const ALL_RIGHT_SECTIONS_CLOSED: Record<RightSectionKey, boolean> = {
  modelSectionOpen: false,
  reasoningEffortSectionOpen: false,
  tempSectionOpen: false,
  maxTokensSectionOpen: false,
  budgetSectionOpen: false,
  toolsSectionOpen: false,
  clientSectionOpen: false,
};

/**
 * Owns the persisted layout and display preferences of both sidebars. Every
 * change is written to browser storage as it is made.
 */
export function useSidebarState() {
  const [sidebarState, setSidebarState] = useState<SidebarState>({ ...DEFAULT_SIDEBAR_STATE });

  // Load persisted sidebar state on mount
  useEffect(() => {
    setSidebarState(loadSidebarState());
  }, []);

  const change = useCallback((compute: (prev: SidebarState) => SidebarState) => {
    setSidebarState((prev) => {
      const next = compute(prev);
      saveSidebarState(next);
      return next;
    });
  }, []);

  const updateSidebar = useCallback(
    (patch: Partial<SidebarState>) => change((prev) => ({ ...prev, ...patch })),
    [change]
  );

  /** Remembers a live runtime window for `provider/model`; stale or non-runtime windows are ignored. */
  const rememberContextWindow = useCallback(
    (provider: string | undefined, model: string, resolved: ResolvedContextWindow) =>
      change((prev) => {
        const next = recordRuntimeWindow(prev.rememberedContextWindows, provider, model, resolved);
        return next === prev.rememberedContextWindows ? prev : { ...prev, rememberedContextWindows: next };
      }),
    [change]
  );

  const { subsections } = sidebarState;
  const isSubsectionOpen = useCallback(
    (key: string) => subsections[key] ?? false,
    [subsections]
  );

  /** Opening a subsection closes the others; closing one leaves the rest alone. */
  const toggleSubsection = useCallback(
    (key: string) =>
      change((prev) => {
        const opening = !(prev.subsections[key] ?? false);
        const cleared = opening
          ? Object.fromEntries(Object.keys(prev.subsections).map((k) => [k, false]))
          : prev.subsections;
        return { ...prev, subsections: { ...cleared, [key]: opening } };
      }),
    [change]
  );

  /** At most one section of the right sidebar is open at a time. */
  const toggleRightSection = useCallback(
    (key: RightSectionKey) =>
      change((prev) => ({ ...prev, ...ALL_RIGHT_SECTIONS_CLOSED, [key]: !prev[key] })),
    [change]
  );

  /** Opens the right sidebar on one section, optionally expanding a subsection inside it. */
  const openRightSection = useCallback(
    (key: RightSectionKey, subsectionKey?: string) =>
      change((prev) => ({
        ...prev,
        ...ALL_RIGHT_SECTIONS_CLOSED,
        rightSidebarOpen: true,
        [key]: true,
        subsections: subsectionKey ? { ...prev.subsections, [subsectionKey]: true } : prev.subsections,
      })),
    [change]
  );

  /** Opens the tools section on a subsection without closing whatever else is open. */
  const revealToolsSubsection = useCallback(
    (subsectionKey: string) =>
      change((prev) => ({
        ...prev,
        rightSidebarOpen: true,
        toolsSectionOpen: true,
        subsections: { ...prev.subsections, [subsectionKey]: true },
      })),
    [change]
  );

  const sidebarRef = useRef(sidebarState);
  sidebarRef.current = sidebarState;

  /** Whether a newly arrived step starts expanded, per the "collapse by default" preferences. */
  const defaultExpanded = useCallback((step: ConversationStep): boolean => {
    const s = sidebarRef.current;
    const kind = step.kind;
    if (kind === "reasoning" && s.collapseReasoning) return false;
    if (kind === "tool_call" && s.collapseTools) return false;
    if (kind === "tool_result" && s.collapseToolCalls) return false;
    if (kind === "meta" && s.collapseServerMessages) return false;
    return true;
  }, []);

  return {
    sidebarState,
    setSidebarState,
    updateSidebar,
    rememberContextWindow,
    isSubsectionOpen,
    toggleSubsection,
    toggleRightSection,
    openRightSection,
    revealToolsSubsection,
    defaultExpanded,
  };
}
