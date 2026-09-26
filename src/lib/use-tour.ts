"use client";

import { readStorage, writeStorage, removeStorage } from "@/src/lib/persistence";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ACTIONS, EVENTS, STATUS, type EventData } from "react-joyride";
import type { Conversation, OllamaModel, ToolDefinition } from "@/src/types/chat";
import { fallbackModels, saveConversationOrder, saveSidebarState, type SidebarState } from "@/src/lib/chat";
import { createTourConversations, tourSteps, TOUR_COMPLETED_KEY, TOUR_STEP_KEY } from "@/src/lib/tour-data";
import { finishTourConversations } from "@/src/lib/tour-session";

export const TOUR_SESSION_KEY = "ollamable.tourSession";
interface TourWorkspace {
  conversations: Conversation[];
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  selectedConversationId: string;
  setSelectedConversationId: Dispatch<SetStateAction<string>>;
  setConversationOrder: Dispatch<SetStateAction<string[] | null>>;
  sidebarState: SidebarState;
  setSidebarState: Dispatch<SetStateAction<SidebarState>>;
  tools: ToolDefinition[];
  models: OllamaModel[];
}
interface TourSession { sidebar: SidebarState; selectedId: string }

/** Owns tour scheduling, restoration and cleanup; callbacks read current workspace state. */
export function useTour(workspace: TourWorkspace) {
  const latest = useRef(workspace);
  latest.current = workspace;
  const [tourRun, setTourRun] = useState(false);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const running = useRef(false);
  const initialized = useRef(false);
  const session = useRef<TourSession | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const cancelTimers = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
  }, []);
  const schedule = useCallback((callback: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.current.delete(timer); callback(); }, delay);
    timers.current.add(timer);
  }, []);
  const updateSidebar = useCallback((patch: Partial<SidebarState>) => {
    latest.current.setSidebarState((previous) => {
      const next = { ...previous, ...patch };
      saveSidebarState(next);
      return next;
    });
  }, []);

  const prepareStep = useCallback((index: number) => {
    const current = latest.current;
    if (index < 7 || index > 10) return;
    const subsections = { ...current.sidebarState.subsections };
    if (index === 7) for (const model of current.models) subsections[`model-${model.providerName ?? "Local"}`] = true;
    if (index === 10) subsections["tools-builtin"] = true;
    updateSidebar({ rightSidebarOpen: true, modelSectionOpen: index === 7,
      tempSectionOpen: index === 8, maxTokensSectionOpen: index === 9,
      toolsSectionOpen: index === 10, subsections });
    if (index === 10) schedule(() => {
      if (!running.current) return;
      const { tools, selectedConversationId, setConversations } = latest.current;
      const tool = tools.find((tool) => tool.name === "web_search");
      if (!tool) return;
      // Only change the tour example, never another conversation selected mid-tour.
      setConversations((conversations) => conversations.map((conversation) =>
        conversation.id === selectedConversationId && conversation._tourExample && !conversation.activeToolIds.includes(tool.id)
          ? { ...conversation, activeToolIds: [...conversation.activeToolIds, tool.id] } : conversation));
    }, 800);
  }, [schedule, updateSidebar]);

  const start = useCallback((manual: boolean) => {
    if (running.current) return;
    if (window.innerWidth < 768) {
      if (manual) window.alert("For the best experience, please use a screen at least 768px wide.");
      return;
    }
    cancelTimers();
    initialized.current = true;
    const current = latest.current;
    let restoredSession: TourSession | null = null;
    if (!manual) {
      try { restoredSession = JSON.parse(readStorage(TOUR_SESSION_KEY) ?? "null"); } catch { /* start fresh */ }
    }
    session.current = restoredSession?.sidebar && typeof restoredSession.selectedId === "string"
      ? restoredSession : { sidebar: structuredClone(current.sidebarState), selectedId: current.selectedConversationId };
    writeStorage(TOUR_SESSION_KEY, JSON.stringify(session.current));
    removeStorage(TOUR_COMPLETED_KEY);
    const existing = current.conversations.filter((conversation) => conversation._tourExample);
    const selected = current.conversations.find((conversation) => conversation.id === current.selectedConversationId);
    const seeded = existing.length ? existing : createTourConversations(selected?.model ?? current.models[0]?.name ?? fallbackModels[0].name, current.tools);
    if (!existing.length) current.setConversations([...seeded, ...current.conversations]);
    current.setSelectedConversationId(seeded[0].id);
    const saved = manual ? 0 : Number(readStorage(TOUR_STEP_KEY) ?? 0);
    const index = Number.isInteger(saved) && saved >= 0 && saved < tourSteps.length ? saved : 0;
    writeStorage(TOUR_STEP_KEY, String(index));
    updateSidebar({ sidebarOpen: true });
    running.current = true;
    prepareStep(index);
    setTourStepIndex(index);
    setTourRun(true);
  }, [cancelTimers, prepareStep, updateSidebar]);

  useEffect(() => {
    if (!initialized.current && readStorage(TOUR_COMPLETED_KEY) !== "true") schedule(() => start(false), 500);
    // A cancelled schedule is not initialization. Strict Mode's replay schedules again.
    return cancelTimers;
  }, [cancelTimers, schedule, start]);

  const finishTour = useCallback(() => {
    if (!running.current) return;
    running.current = false;
    cancelTimers();
    setTourRun(false);
    setTourStepIndex(0);
    writeStorage(TOUR_COMPLETED_KEY, "true");
    removeStorage(TOUR_STEP_KEY);
    removeStorage(TOUR_SESSION_KEY);
    const current = latest.current;
    const remaining = finishTourConversations(current.conversations,
      (conversation) => createTourConversations(conversation.model, conversation.availableTools)[0]);
    current.setConversations(remaining);
    const validIds = new Set(remaining.map((conversation) => conversation.id));
    current.setConversationOrder((order) => {
      if (!order) return null;
      const next = order.filter((id) => validIds.has(id));
      saveConversationOrder(next);
      return next;
    });
    const previousId = session.current?.selectedId;
    current.setSelectedConversationId(validIds.has(current.selectedConversationId) ? current.selectedConversationId
      : previousId && validIds.has(previousId) ? previousId : remaining[0]?.id ?? "");
    if (session.current) {
      current.setSidebarState(session.current.sidebar);
      saveSidebarState(session.current.sidebar);
      session.current = null;
    }
  }, [cancelTimers]);

  const advanceToStep = useCallback((index: number) => {
    if (!running.current) return;
    setTourStepIndex(index);
    writeStorage(TOUR_STEP_KEY, String(index));
  }, []);
  const handleJoyrideEvent = useCallback((data: EventData) => {
    const { action, index, status, type } = data;
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED || action === ACTIONS.CLOSE) { finishTour(); return; }
    if (type !== EVENTS.TARGET_NOT_FOUND && type !== EVENTS.STEP_AFTER) return;
    const next = index + (action === ACTIONS.PREV ? -1 : 1);
    if (next >= tourSteps.length) { finishTour(); return; }
    if (next < 0) return;
    prepareStep(next);
    if (next === 7) schedule(() => advanceToStep(next), 400);
    else advanceToStep(next);
  }, [advanceToStep, finishTour, prepareStep, schedule]);

  return { tourRun, tourStepIndex, handleStartTour: () => start(true), handleJoyrideEvent, finishTour };
}
