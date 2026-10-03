"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Joyride } from "react-joyride";
import { Alert, Box, Dialog, DialogContent, DialogTitle, Typography } from "@mui/material";
import type { Conversation, ToolDefinition } from "@/src/types/chat";
import { Composer } from "@/src/components/composer";
import { ContextMeter } from "@/src/components/context-meter";
import { ConversationSidebar } from "@/src/components/conversation-sidebar";
import { APP_BAR_HEIGHT, RIGHT_SIDEBAR_WIDTH, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from "@/src/components/layout";
import { ModelMetaDialog, useModelMeta } from "@/src/components/model-meta-dialog";
import { RequestJsonDialog } from "@/src/components/request-json-dialog";
import { SettingsSidebar } from "@/src/components/settings/settings-sidebar";
import { toolSubsectionKey } from "@/src/components/settings/tools-section";
import { Transcript } from "@/src/components/transcript";
import { WorkspaceAppBar } from "@/src/components/workspace-app-bar";
import { BackendClient, WS_URL } from "@/src/lib/backend-client";
import { createStep, inferTitle } from "@/src/lib/chat";
import { findModel } from "@/src/lib/models";
import { usePersistenceStatus } from "@/src/lib/persistence";
import { tourSteps } from "@/src/lib/tour-data";
import { deleteLastExchangeCutIndex, findResponseStartIndex } from "@/src/lib/transcript";
import { useBackendCatalog } from "@/src/lib/use-backend-catalog";
import { useChatGeneration, type ContextRequestFields } from "@/src/lib/use-chat-generation";
import { isCompactContextEnabled } from "@/shared/context-usage";
import { useContextWindow } from "@/src/lib/use-context-window";
import { useConversations } from "@/src/lib/use-conversations";
import { useSidebarState } from "@/src/lib/use-sidebar-state";
import { useTour } from "@/src/lib/use-tour";
import { useWebSocket } from "@/src/lib/use-websocket";

/**
 * Composition root of the app. It wires the state owners (conversations,
 * sidebar preferences, backend catalog, generation, tour) to the three panes
 * and holds the actions that turn a user's edit of the transcript into the
 * next request. Rendering and pane-local state live in the pane components.
 */
export function ChatWorkspace() {
  const persistenceFailed = usePersistenceStatus();
  const [error, setError] = useState<string>("");
  const [composerValue, setComposerValue] = useState("");
  const [requestJsonOpen, setRequestJsonOpen] = useState(false);
  const backendClientRef = useRef(new BackendClient());

  const {
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
  } = useSidebarState();
  const { sidebarOpen, rightSidebarOpen } = sidebarState;

  const { models, availableModels, modelDiscoveryState, tools, mergeTools } = useBackendCatalog(setError);

  const {
    conversations,
    setConversations,
    conversationOrder,
    setConversationOrder,
    selectedConversationId,
    setSelectedConversationId,
    selectedConversation,
    updateConversation,
    addConversation,
    addForkedConversation,
    deleteConversation,
    reorderConversations,
  } = useConversations(tools);

  const { tourRun, tourStepIndex, handleStartTour, handleJoyrideEvent } = useTour({
    conversations, setConversations, selectedConversationId, setSelectedConversationId,
    setConversationOrder, sidebarState, setSidebarState, tools, models,
  });

  const handleWsMessage = useCallback(
    (data: unknown) => {
      const msg = data as { type?: string; tools?: ToolDefinition[] };
      if (msg.type === "tools.update" && msg.tools) {
        mergeTools(msg.tools);
        return;
      }
      backendClientRef.current.handleServerMessage(data);
    },
    [mergeTools]
  );

  const { send: wsSend, connected: wsConnected } = useWebSocket(WS_URL, handleWsMessage, () => backendClientRef.current.connectionClosed());

  const activeTools = useMemo(
    () =>
      selectedConversation?.availableTools.filter((tool) =>
        selectedConversation.activeToolIds.includes(tool.id)
      ) ?? [],
    [selectedConversation]
  );
  const compactContextActive = isCompactContextEnabled(activeTools);
  // Filled below from the one context-window resolution (the meter's); read when a request is sent.
  const contextRequestRef = useRef<(conversation: Conversation) => ContextRequestFields>(() => ({}));

  const { streaming, settledCount, stoppedConversationId, streamConversationResponse, stopGeneration, resumeGeneration } =
    useChatGeneration({
      backendClient: backendClientRef.current,
      send: wsSend,
      connected: wsConnected,
      availableModels,
      updateConversation,
      defaultExpanded,
      setError,
      getContextRequest: (conversation) => contextRequestRef.current(conversation),
      onFork: addForkedConversation,
    });

  const modelMeta = useModelMeta();

  const selectedModel = useMemo(
    () => findModel(availableModels, selectedConversation?.model, selectedConversation?.provider),
    [availableModels, selectedConversation?.model, selectedConversation?.provider]
  );
  const contextWindow = useContextWindow({
    // The same resolution feeds the meter, the usage note's window in chat.send and the request preview.
    enabled: sidebarState.showContextMeter || compactContextActive,
    conversation: selectedConversation,
    model: selectedModel,
    remembered: sidebarState.rememberedContextWindows,
    rememberContextWindow,
    settledCount,
  });
  contextRequestRef.current = (conversation) =>
    conversation.id === selectedConversation?.id
      ? {
          contextWindow: contextWindow.window?.tokens,
          contextWindowSource: contextWindow.window?.source,
          modelFamily: selectedModel?.family,
        }
      : {};

  // Computed token boundaries for the token view: all separator/whitespace/
  // boundary logic lives in src/lib/token-view.ts — this only wires
  // backend-client.tokenize() to the current model.
  const tokenizeStepText = useCallback(
    (text: string) => {
      const model = selectedConversation?.model;
      if (!model) return Promise.reject(new Error("no active model"));
      // Explicit provider avoids the router's model-name-only modelProviderMap fallback.
      return backendClientRef.current.tokenize(wsSend, model, text, selectedConversation?.provider).then((r) => r.tokens);
    },
    [selectedConversation?.model, selectedConversation?.provider, wsSend]
  );

  useEffect(() => {
    // Discovery can be delayed or partial. Absence never proves a saved selection invalid.
    if (modelDiscoveryState !== "ready" || !selectedConversation || selectedConversation.provider !== undefined) return;
    const matches = models.filter((model) => model.name === selectedConversation.model);
    // Migrate legacy name-only selections only when provider identity is unambiguous.
    if (matches.length === 1 && matches[0].provider !== undefined) {
      updateConversation(selectedConversation.id, (conversation) => ({
        ...conversation,
        provider: matches[0].provider,
      }));
    }
  }, [models, modelDiscoveryState, selectedConversation, updateConversation]);

  /** Applies a settings change to the selected conversation. */
  function changeSelectedConversation(patch: Partial<Conversation>) {
    if (!selectedConversation) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      ...patch,
      updatedAt: new Date().toISOString(),
    }));
  }

  function handleCreateConversation() {
    addConversation(availableModels[0]);
    setComposerValue("");
  }

  function handleOpenModelMeta() {
    if (selectedModel) {
      void modelMeta.show(selectedModel);
    }
  }

  function handleSystemPromptChange(value: string) {
    if (!selectedConversation) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => {
      const nextSteps = conversation.steps.map((step, index) =>
        index === 0 && step.kind === "system" ? { ...step, content: value } : step
      );

      return {
        ...conversation,
        systemPrompt: value,
        steps: nextSteps,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  function setStepExpanded(stepId: string, expanded: (current: boolean) => boolean) {
    if (!selectedConversation) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      steps: conversation.steps.map((step) =>
        step.id === stepId ? { ...step, expanded: expanded(Boolean(step.expanded)) } : step
      ),
    }));
  }

  function handleToggleConversationTool(toolId: string) {
    if (!selectedConversation) {
      return;
    }

    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      activeToolIds: conversation.activeToolIds.includes(toolId)
        ? conversation.activeToolIds.filter((id) => id !== toolId)
        : [...conversation.activeToolIds, toolId],
      updatedAt: new Date().toISOString(),
    }));
  }

  /** Makes `steps` the selected conversation's transcript and requests the response to it. */
  async function continueFrom(steps: Conversation["steps"], retitle: boolean) {
    if (!selectedConversation) {
      return;
    }

    const nextConversation = {
      ...selectedConversation,
      title: retitle && !selectedConversation.titleEdited ? inferTitle(steps) : selectedConversation.title,
      steps,
      updatedAt: new Date().toISOString(),
    };

    updateConversation(selectedConversation.id, () => nextConversation);
    await streamConversationResponse(nextConversation);
  }

  async function handleSendPrompt() {
    if (!selectedConversation || !composerValue.trim() || streaming) {
      return;
    }

    const prompt = composerValue.trim();
    setComposerValue("");

    await continueFrom([...selectedConversation.steps, createStep("user", "User", prompt)], true);
  }

  /** Replaces a user message; everything after it is discarded and regenerated. */
  async function handleEditUserStep(stepId: string, content: string) {
    if (!selectedConversation) {
      return;
    }

    const stepIndex = selectedConversation.steps.findIndex((step) => step.id === stepId);
    const targetStep = selectedConversation.steps[stepIndex];
    if (targetStep?.kind !== "user") {
      return;
    }

    await continueFrom(
      [...selectedConversation.steps.slice(0, stepIndex), { ...targetStep, content, expanded: true }],
      true
    );
  }

  async function handleResendUserStep(stepId: string) {
    if (!selectedConversation || streaming) {
      return;
    }

    const stepIndex = selectedConversation.steps.findIndex((step) => step.id === stepId);
    if (selectedConversation.steps[stepIndex]?.kind !== "user") {
      return;
    }

    await continueFrom(selectedConversation.steps.slice(0, stepIndex + 1), false);
  }

  async function handleRegenerateAssistantStep(stepId: string) {
    if (!selectedConversation || streaming) {
      return;
    }

    const stepIndex = selectedConversation.steps.findIndex((step) => step.id === stepId);
    if (selectedConversation.steps[stepIndex]?.kind !== "assistant") {
      return;
    }

    const responseStartIndex = findResponseStartIndex(selectedConversation.steps, stepIndex);
    await continueFrom(selectedConversation.steps.slice(0, responseStartIndex), false);
  }

  function handleDeleteLastExchange() {
    if (!selectedConversation || streaming) {
      return;
    }

    const cutIndex = deleteLastExchangeCutIndex(selectedConversation.steps);
    if (cutIndex === -1) {
      return;
    }

    updateConversation(selectedConversation.id, (conv) => ({
      ...conv,
      steps: conv.steps.slice(0, cutIndex),
      updatedAt: new Date().toISOString(),
    }));
  }

  function handleResume() {
    if (!selectedConversation || streaming) return;
    void resumeGeneration(selectedConversation);
  }

  function navigateToTool(toolId: string) {
    // Open right sidebar, expand tools section and the subsection the tool is listed under
    revealToolsSubsection(toolSubsectionKey(toolId));

    // Scroll to the tool after the sidebar animations settle
    requestAnimationFrame(() => {
      setTimeout(() => {
        const el = document.querySelector(`[data-tool-id="${toolId}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 350);
    });
  }

  const forkOriginConversation = selectedConversation?.forkedFrom
    ? conversations.find((conversation) => conversation.id === selectedConversation.forkedFrom?.conversationId)
    : undefined;
  const forkOrigin = forkOriginConversation && { id: forkOriginConversation.id, title: forkOriginConversation.title };
  const canResume = !streaming
    && stoppedConversationId != null
    && selectedConversation != null
    && stoppedConversationId === selectedConversation.id
    && (() => {
      const lastStep = selectedConversation.steps[selectedConversation.steps.length - 1];
      return lastStep != null && lastStep.kind !== "assistant";
    })();
  const bothSidebarsOpen = sidebarOpen && rightSidebarOpen;

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100dvh",
        overflow: "hidden",
        overscrollBehavior: "none",
        color: "text.primary",
      }}
    >
      <Joyride
        steps={tourSteps}
        run={tourRun}
        stepIndex={tourStepIndex}
        continuous
        scrollToFirstStep
        onEvent={handleJoyrideEvent}
        locale={{
          back: "Back",
          close: "Close",
          last: "Finish",
          next: "Next",
          skip: "Skip tour",
        }}
        options={{
          skipBeacon: true,
          scrollDuration: 0,
          showProgress: true,
          overlayClickAction: false,
          primaryColor: "#2457d6",
          textColor: "#333333",
          backgroundColor: "#ffffff",
          zIndex: 10000,
          buttons: ["back", "close", "primary", "skip"],
        }}
        styles={{
          tooltip: {
            borderRadius: 18,
            fontFamily: "'IBM Plex Sans', 'Segoe UI', sans-serif",
          },
        }}
      />
      <WorkspaceAppBar
        conversation={selectedConversation}
        model={selectedModel}
        onOpenSection={openRightSection}
      />

      <Box sx={{ display: "flex", flexGrow: 1, minHeight: `calc(100dvh - ${APP_BAR_HEIGHT}px)`, overflow: "hidden" }}>
        <ConversationSidebar
          open={sidebarOpen}
          onOpenChange={(open) => updateSidebar({ sidebarOpen: open })}
          showTour={sidebarState.showTour}
          conversations={conversations}
          conversationOrder={conversationOrder}
          selectedConversationId={selectedConversationId}
          onSelect={setSelectedConversationId}
          onCreate={handleCreateConversation}
          onStartTour={handleStartTour}
          onViewRequestJson={() => setRequestJsonOpen(true)}
          onUpdate={updateConversation}
          onDelete={deleteConversation}
          onReorder={reorderConversations}
        />

        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            flexGrow: 1,
            minWidth: 0,
            minHeight: 0,
            py: 1,
            gap: 1,
            maxWidth: `calc(100vw - ${sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH}px - ${rightSidebarOpen ? RIGHT_SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH}px)`,
            transition: "max-width 0.35s ease",
          }}
        >
          {persistenceFailed ? <Alert severity="warning" role="alert" sx={{ flexShrink: 0 }}>
            Browser storage is unavailable or full. Some changes are not saved. Keep this tab open and copy unsaved messages before reloading.
          </Alert> : null}
          {selectedConversation ? (
            <>
              <Transcript
                conversation={selectedConversation}
                activeTools={activeTools}
                error={error}
                wide={bothSidebarsOpen}
                streaming={streaming}
                canResume={canResume}
                autoScroll={!tourRun}
                hideSystemPrompt={sidebarState.hideSystemPrompt}
                showExamples={sidebarState.showExamples}
                showTokens={sidebarState.showTokens}
                renderMarkdown={sidebarState.renderMarkdown}
                tokenizeText={tokenizeStepText}
                onSystemPromptChange={handleSystemPromptChange}
                onToggleStep={(stepId) => setStepExpanded(stepId, (current) => !current)}
                onExpandStep={(stepId) => setStepExpanded(stepId, () => true)}
                onEditUserStep={(stepId, content) => void handleEditUserStep(stepId, content)}
                onResendUserStep={(stepId) => void handleResendUserStep(stepId)}
                onRegenerateAssistantStep={(stepId) => void handleRegenerateAssistantStep(stepId)}
                onDeleteLastExchange={handleDeleteLastExchange}
                onResume={handleResume}
                onNavigateToTool={navigateToTool}
                forkOrigin={forkOrigin}
                onOpenConversation={setSelectedConversationId}
                findConversationTitle={(id) => conversations.find((conversation) => conversation.id === id)?.title}
              />
              {sidebarState.showContextMeter ? (
                <ContextMeter fill={contextWindow.fill} window={contextWindow.window} wide={bothSidebarsOpen} />
              ) : null}
              <Composer
                value={composerValue}
                onChange={setComposerValue}
                wide={bothSidebarsOpen}
                streaming={streaming}
                onSend={() => void handleSendPrompt()}
                onStop={stopGeneration}
              />
            </>
          ) : null}
        </Box>

        <SettingsSidebar
          conversation={selectedConversation}
          models={availableModels}
          selectedModel={selectedModel}
          sidebarState={sidebarState}
          onUpdateSidebar={updateSidebar}
          onToggleSection={toggleRightSection}
          isSubsectionOpen={isSubsectionOpen}
          onToggleSubsection={toggleSubsection}
          onChangeSettings={changeSelectedConversation}
          onToggleTool={handleToggleConversationTool}
          onDisableAllTools={() => changeSelectedConversation({ activeToolIds: [] })}
          onOpenModelMeta={handleOpenModelMeta}
        />
      </Box>

      <Dialog open={!wsConnected}>
        <DialogTitle>Backend not connected</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Unable to connect to the backend server. All model requests are routed through the backend.
          </Alert>
          <Typography variant="body2" color="text.secondary">
            Make sure the server is running with <code>make dev</code> and try refreshing the page.
          </Typography>
        </DialogContent>
      </Dialog>

      <ModelMetaDialog
        open={modelMeta.open}
        onClose={modelMeta.close}
        title={selectedConversation?.model ?? "Model metadata"}
        loading={modelMeta.loading}
        error={modelMeta.error}
        meta={modelMeta.meta}
      />

      <RequestJsonDialog
        open={requestJsonOpen}
        onClose={() => setRequestJsonOpen(false)}
        conversation={selectedConversation}
        model={selectedModel}
        activeTools={activeTools}
        contextWindow={contextWindow.window}
        showTokens={sidebarState.showTokens}
        tokenizeText={tokenizeStepText}
      />
    </Box>
  );
}
