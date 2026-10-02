"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Paper, Stack, TextField, Typography } from "@mui/material";
import PlayArrowOutlinedIcon from "@mui/icons-material/PlayArrowOutlined";
import type { Conversation, ConversationStep, ToolDefinition } from "@/src/types/chat";
import { JsonPreviewDialog } from "@/src/components/json-preview-dialog";
import { contentColumnWidth } from "@/src/components/layout";
import { StepCard } from "@/src/components/step-card";
import { wrapWithThreadBars } from "@/src/components/thread-bars";
import { TranscriptStep } from "@/src/components/transcript-step";
import { SYSTEM_PROMPT_EXAMPLES } from "@/src/lib/chat";
import { modelIdentity } from "@/src/lib/model-identity";
import {
  annotateTranscriptSteps,
  findLastDeletableStepIndex,
  isVisibleTranscriptStep,
  stepThreadDepth,
} from "@/src/lib/transcript";
import { toOpenAIMessages } from "@/shared/openai-format";

const TOOLS_CARD_ID = "tools-card";

interface TranscriptProps {
  conversation: Conversation;
  /** The conversation's enabled tools, as sent with each request. */
  activeTools: ToolDefinition[];
  error: string;
  /** Both sidebars are open, so the column may use its wider measure. */
  wide: boolean;
  streaming: boolean;
  canResume: boolean;
  /** Scroll to the end when the conversation changes or a step arrives. */
  autoScroll: boolean;
  hideSystemPrompt: boolean;
  showExamples: boolean;
  showTokens: boolean;
  renderMarkdown: boolean;
  tokenizeText: (text: string) => Promise<string[]>;
  onSystemPromptChange: (value: string) => void;
  onToggleStep: (stepId: string) => void;
  onExpandStep: (stepId: string) => void;
  /** Replaces a user message and regenerates everything after it. */
  onEditUserStep: (stepId: string, content: string) => void;
  onResendUserStep: (stepId: string) => void;
  onRegenerateAssistantStep: (stepId: string) => void;
  onDeleteLastExchange: () => void;
  onResume: () => void;
  onNavigateToTool: (toolId: string) => void;
}

/**
 * The selected conversation as it happened: system prompt, enabled tools and
 * every step in chronological order. Owns message editing and the per-step
 * "inspect as OpenAI message" dialog.
 */
export function Transcript({
  conversation,
  activeTools,
  error,
  wide,
  streaming,
  canResume,
  autoScroll,
  hideSystemPrompt,
  showExamples,
  showTokens,
  renderMarkdown,
  tokenizeText,
  onSystemPromptChange,
  onToggleStep,
  onExpandStep,
  onEditUserStep,
  onResendUserStep,
  onRegenerateAssistantStep,
  onDeleteLastExchange,
  onResume,
  onNavigateToTool,
}: TranscriptProps) {
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [stepDraft, setStepDraft] = useState("");
  const [inspectStep, setInspectStep] = useState<ConversationStep | null>(null);
  const [toolsCardExpanded, setToolsCardExpanded] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const previousConversationIdRef = useRef<string>("");
  const previousStepCountRef = useRef(0);

  const stepCount = conversation.steps.length;
  useEffect(() => {
    setEditingStepId(null);
    setStepDraft("");
  }, [conversation.id]);

  useEffect(() => {
    const conversationChanged = previousConversationIdRef.current !== conversation.id;
    const newStepAdded = stepCount > previousStepCountRef.current;

    if (autoScroll && (conversationChanged || newStepAdded)) {
      transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }

    previousConversationIdRef.current = conversation.id;
    previousStepCountRef.current = stepCount;
  }, [conversation.id, stepCount, autoScroll]);

  const transcriptItems = useMemo(
    () => annotateTranscriptSteps(conversation.steps.filter(isVisibleTranscriptStep)),
    [conversation.steps]
  );
  const lastDeletableStepId = useMemo(() => {
    if (streaming) return null;
    return conversation.steps[findLastDeletableStepIndex(conversation.steps)]?.id ?? null;
  }, [conversation.steps, streaming]);

  function handleStartStepEdit(step: ConversationStep) {
    if (step.kind !== "user" || streaming) {
      return;
    }

    onExpandStep(step.id);
    setEditingStepId(step.id);
    setStepDraft(step.content);
  }

  function handleCancelStepEdit() {
    setEditingStepId(null);
    setStepDraft("");
  }

  function handleSaveStepEdit(stepId: string) {
    const nextContent = stepDraft.trim();
    handleCancelStepEdit();
    if (nextContent) {
      onEditUserStep(stepId, nextContent);
    }
  }

  function handleInspectTools() {
    const toolsJson = activeTools.map((t) => {
      let parameters: unknown;
      try { parameters = JSON.parse(t.inputSchema); } catch { parameters = t.inputSchema; }
      return { type: "function", function: { name: t.name, description: t.description, parameters } };
    });
    setInspectStep({
      id: TOOLS_CARD_ID, kind: "system", title: "Tools",
      content: JSON.stringify(toolsJson, null, 2),
      createdAt: conversation.createdAt,
    });
  }

  const cacheKeySuffix = modelIdentity(conversation.provider, conversation.model);
  const items = transcriptItems.map((item) => {
    const { step } = item;
    return {
      key: step.id,
      depth: item.toolCalls.length > 0 ? 1 : stepThreadDepth(step.kind),
      element: (
        <TranscriptStep
          key={step.id}
          item={item}
          streaming={streaming}
          isLastDeletable={step.id === lastDeletableStepId}
          isEditing={editingStepId === step.id}
          stepDraft={stepDraft}
          showTokens={showTokens}
          renderMarkdown={renderMarkdown}
          tokenizeText={tokenizeText}
          cacheKeySuffix={cacheKeySuffix}
          onToggle={() => onToggleStep(step.id)}
          onInspect={() => setInspectStep(step)}
          onStartEdit={() => handleStartStepEdit(step)}
          onStepDraftChange={setStepDraft}
          onSaveEdit={() => handleSaveStepEdit(step.id)}
          onCancelEdit={handleCancelStepEdit}
          onResend={() => onResendUserStep(step.id)}
          onRegenerate={() => onRegenerateAssistantStep(step.id)}
          onDeleteLastExchange={onDeleteLastExchange}
        />
      ),
    };
  });

  return (
    <>
      <Box data-tour="transcript" sx={{
        flexGrow: 1,
        minHeight: 0,
        width: "100%",
        maxWidth: contentColumnWidth(wide) + 48,
        transition: "max-width 0.35s ease",
        overflowY: "auto",
        px: 2,
        scrollbarGutter: "stable",
        maskImage: "linear-gradient(to bottom, transparent, black 2px, black calc(100% - 12px), transparent)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent, black 2px, black calc(100% - 12px), transparent)",
      }}>
        <Stack spacing={2} sx={{ pt: 1, pb: 1, maxWidth: contentColumnWidth(wide), mx: "auto", transition: "max-width 0.35s ease" }}>
          {error ? <Alert severity="warning">{error}</Alert> : null}

          {!hideSystemPrompt && (
            <TextField
              data-tour="system-prompt"
              label="System prompt"
              InputLabelProps={{ shrink: true }}
              multiline
              minRows={2}
              maxRows={12}
              value={conversation.systemPrompt}
              onChange={(event) => onSystemPromptChange(event.target.value)}
              placeholder="No system prompt set."
              sx={{ width: "100%" }}
            />
          )}

          {!hideSystemPrompt && showExamples && !conversation.steps.some((s) => s.kind === "user") ? (
            <Stack data-testid="system-prompt-examples" spacing={1}>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {SYSTEM_PROMPT_EXAMPLES.map((example) => (
                  <Chip
                    key={example.label}
                    label={example.label}
                    variant="outlined"
                    size="small"
                    onClick={() => onSystemPromptChange(example.prompt)}
                    data-testid={`example-${example.label.toLowerCase().replace(/\s+/g, "-")}`}
                  />
                ))}
              </Stack>
            </Stack>
          ) : null}

          {activeTools.length > 0 ? (
            <StepCard
              step={{ id: TOOLS_CARD_ID, kind: "system", title: "Tools", content: "", createdAt: conversation.createdAt }}
              dataTour="tools-overview"
              expanded={toolsCardExpanded}
              onToggle={() => setToolsCardExpanded((v) => !v)}
              onInspect={handleInspectTools}
              headerLabel={`tools (${activeTools.length})`}
            >
              <Stack spacing={1}>
                {activeTools.map((tool) => (
                  <Box key={tool.id} onClick={() => onNavigateToTool(tool.id)} sx={{ cursor: "pointer", "&:hover": { opacity: 0.7 } }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{tool.name}</Typography>
                    <Typography variant="body2" color="text.secondary">{tool.description}</Typography>
                  </Box>
                ))}
              </Stack>
            </StepCard>
          ) : null}

          {/* Protocol activity (tool calls, results, metadata) stays at its
              chronological position so each turn reads as it happened; the
              thread bars and headers distinguish it from chat messages. */}
          <Stack component="section" aria-label="Conversation transcript" spacing={2}>
            {wrapWithThreadBars(items)}
          </Stack>
          {streaming ? (
            <Paper
              sx={{
                p: 3,
                border: "1px solid",
                borderColor: "divider",
                backgroundColor: "var(--surface-card)",
                filter: "blur(2px)",
                opacity: 0.5,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 80,
              }}
            >
              <CircularProgress size={24} />
            </Paper>
          ) : canResume ? (
            <Button
              variant="outlined"
              size="small"
              startIcon={<PlayArrowOutlinedIcon />}
              onClick={onResume}
              aria-label="Resume generation"
              sx={{ alignSelf: "center" }}
            >
              Resume
            </Button>
          ) : null}
          <Box ref={transcriptEndRef} aria-hidden="true" />
        </Stack>
      </Box>

      <JsonPreviewDialog
        open={inspectStep != null}
        onClose={() => setInspectStep(null)}
        title={inspectStep ? (inspectStep.id === TOOLS_CARD_ID ? "tools" : inspectStep.kind.replace("_", " ")) : ""}
        subtitle="OpenAI-compatible format"
        json={inspectStep ? inspectJson(inspectStep) : ""}
      />
    </>
  );
}

function inspectJson(step: ConversationStep): string {
  if (step.id === TOOLS_CARD_ID) return step.content;
  const msgs = toOpenAIMessages([step]);
  if (msgs.length === 0) return "(not sent to LLM)";
  return JSON.stringify(msgs.length === 1 ? msgs[0] : msgs, null, 2);
}
