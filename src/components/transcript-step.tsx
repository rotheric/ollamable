"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Box, Button, IconButton, Stack, TextField, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import ReplayOutlinedIcon from "@mui/icons-material/ReplayOutlined";
import type { ConversationStep } from "@/src/types/chat";
import { StepCard, getStepBackgroundColor } from "@/src/components/step-card";
import { TokenViewStepContent } from "@/src/components/token-view-step-content";
import { compactionHarnessForkId } from "@/src/lib/fork";
import { formatStepFooterMeta, formatStepHeader, prettyPrintJson, type TranscriptItem } from "@/src/lib/transcript";

const MARKDOWN_SX = { lineHeight: 1.7, color: "text.primary", "& pre": { fontFamily: "monospace", whiteSpace: "pre-wrap", backgroundColor: "var(--surface-inset)", p: 1.5, borderRadius: 1, overflow: "auto" }, "& code": { fontFamily: "monospace", fontSize: "0.9em" }, "& p:first-of-type": { mt: 0 }, "& p:last-of-type": { mb: 0 }, "& table": { borderCollapse: "collapse", width: "100%", my: 1 }, "& th, & td": { border: "1px solid", borderColor: "divider", px: 1.5, py: 0.75, textAlign: "left" }, "& th": { backgroundColor: "var(--surface-inset)", fontWeight: 600 } };

export interface TranscriptStepProps {
  item: TranscriptItem;
  streaming: boolean;
  /** Only the last chat message offers "Delete message". */
  isLastDeletable: boolean;
  isEditing: boolean;
  stepDraft: string;
  showTokens: boolean;
  renderMarkdown: boolean;
  tokenizeText: (text: string) => Promise<string[]>;
  cacheKeySuffix: string;
  onToggle: () => void;
  onInspect: () => void;
  onStartEdit: () => void;
  onStepDraftChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onResend: () => void;
  onRegenerate: () => void;
  onDeleteLastExchange: () => void;
  /** Title of the conversation a compaction harness step points at; absent when that conversation no longer exists. */
  compactionForkTitle?: string;
  onOpenConversation?: (conversationId: string) => void;
}

/** One transcript entry: a chat message, or protocol activity (reasoning, tool call, tool result, server event). */
export function TranscriptStep({
  item,
  streaming,
  isLastDeletable,
  isEditing,
  stepDraft,
  showTokens,
  renderMarkdown,
  tokenizeText,
  cacheKeySuffix,
  onToggle,
  onInspect,
  onStartEdit,
  onStepDraftChange,
  onSaveEdit,
  onCancelEdit,
  onResend,
  onRegenerate,
  onDeleteLastExchange,
  compactionForkTitle,
  onOpenConversation,
}: TranscriptStepProps) {
  const theme = useTheme();
  const { step, dataTour, toolCalls, cumulativeToolCalls } = item;
  const hasToolCalls = toolCalls.length > 0;
  const isProse = step.kind === "assistant" || step.kind === "user" || step.kind === "reasoning";

  const forkConversationId = compactionHarnessForkId(step);

  const deleteAction = isLastDeletable ? (
    <IconButton
      size="small"
      onClick={onDeleteLastExchange}
      aria-label="Delete message"
    >
      <DeleteOutlinedIcon fontSize="small" />
    </IconButton>
  ) : null;
  const copyAction = (
    <IconButton
      size="small"
      onClick={() => void navigator.clipboard.writeText(step.content)}
      aria-label="Copy message"
    >
      <ContentCopyOutlinedIcon fontSize="small" />
    </IconButton>
  );

  return (
    <StepCard
      step={step}
      dataTour={dataTour}
      expanded={Boolean(step.expanded)}
      onToggle={onToggle}
      onInspect={step.kind !== "meta" && step.kind !== "reasoning" && step.kind !== "compaction" ? onInspect : undefined}
      headerLabel={hasToolCalls ? "tool call requests" : formatStepHeader(step)}
      footerMeta={footerMeta(step, toolCalls.length, cumulativeToolCalls)}
      bgColor={hasToolCalls ? getStepBackgroundColor("tool_call", theme) : undefined}
      onDoubleClickContent={step.kind === "user" && !streaming && !isEditing ? onStartEdit : undefined}
      footerActions={
        step.kind === "user" ? (
          <>
            {copyAction}
            <IconButton
              size="small"
              onClick={onStartEdit}
              disabled={streaming}
              aria-label="Edit message"
            >
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              onClick={onResend}
              disabled={streaming}
              aria-label="Resend message"
            >
              <ReplayOutlinedIcon fontSize="small" />
            </IconButton>
            {deleteAction}
          </>
        ) : step.kind === "assistant" && !hasToolCalls ? (
          <>
            {copyAction}
            <IconButton
              size="small"
              onClick={onRegenerate}
              disabled={streaming}
              aria-label="Regenerate response"
            >
              <ReplayOutlinedIcon fontSize="small" />
            </IconButton>
            {deleteAction}
          </>
        ) : undefined
      }
    >
      {forkConversationId !== undefined ? (
        <Typography variant="body1" data-testid="compaction-harness-event" sx={{ lineHeight: 1.7, color: "text.primary" }}>
          {compactionForkTitle !== undefined && onOpenConversation ? (
            <>
              Context compacted by the app &mdash; continued in{" "}
              <Button
                variant="text"
                size="small"
                onClick={() => onOpenConversation(forkConversationId)}
                aria-label="Open forked conversation"
                data-testid="compaction-fork-link"
                sx={{ textTransform: "none", verticalAlign: "baseline", p: 0, minWidth: 0 }}
              >
                &ldquo;{compactionForkTitle}&rdquo;
              </Button>
            </>
          ) : (
            step.content
          )}
        </Typography>
      ) : step.metaEvent?.data ? (
        <Typography variant="body2" sx={{ mb: 1, fontFamily: "monospace", whiteSpace: "pre-wrap", color: "text.secondary" }}>
          {JSON.stringify(step.metaEvent.data, null, 2)}
        </Typography>
      ) : null}
      {step.kind === "tool_result" && step.toolResult ? (
        <Typography variant="body2" sx={{ mb: 1 }}>
          {step.toolResult.name}
        </Typography>
      ) : null}
      {hasToolCalls ? (
        <Stack spacing={2}>
          {toolCalls.map((tc, i) => (
            <Box key={tc.id ?? i}>
              <Typography variant="body2" sx={{ mb: 0.5 }}>
                {tc.name}
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap", color: "text.secondary" }}>
                {JSON.stringify(tc.arguments, null, 2)}
              </Typography>
            </Box>
          ))}
        </Stack>
      ) : null}
      {step.kind === "tool_call" || forkConversationId !== undefined ? null : isEditing ? (
        <Stack spacing={1.5}>
          <TextField
            label="Edit message"
            multiline
            minRows={3}
            value={stepDraft}
            onChange={(event) => onStepDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSaveEdit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelEdit();
              }
            }}
            autoFocus
          />
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button variant="text" color="inherit" onClick={onCancelEdit}>Abort</Button>
            <Button variant="contained" onClick={onSaveEdit}>Send</Button>
          </Stack>
        </Stack>
      ) : (showTokens && isProse) ? (
        <TokenViewStepContent step={step} tokenizeText={tokenizeText} cacheKeySuffix={cacheKeySuffix} />
      ) : ((isProse || step.kind === "compaction") && renderMarkdown) ? (
        <Box sx={MARKDOWN_SX}>
          <Markdown remarkPlugins={[remarkGfm]}>{step.content.replace(/^\n+|\n+$/g, "")}</Markdown>
        </Box>
      ) : (
        <Typography variant="body1" sx={{ whiteSpace: "pre-wrap", lineHeight: 1.7, color: "text.primary", fontFamily: step.kind === "tool_result" ? "monospace" : undefined }}>
          {isProse
            ? step.content.replace(/^\n+|\n+$/g, "")
            : step.kind === "tool_result"
              ? prettyPrintJson(step.content)
              : (step.kind === "meta" && step.metaEvent?.kind === "search_result")
                ? ""
                : step.content}
        </Typography>
      )}
    </StepCard>
  );
}

function footerMeta(step: ConversationStep, toolCallCount: number, cumulativeToolCalls: number): string | null {
  const baseMeta = toolCallCount > 0
    ? [step.model, `${toolCallCount} tool${toolCallCount !== 1 ? "s" : ""}`, formatStepFooterMeta(step)].filter(Boolean).join(" / ")
    : formatStepFooterMeta(step);
  if (step.kind === "assistant" && cumulativeToolCalls > 0) {
    const suffix = `tool calls: ${cumulativeToolCalls}`;
    return baseMeta ? `${baseMeta} / ${suffix}` : suffix;
  }
  return baseMeta;
}
