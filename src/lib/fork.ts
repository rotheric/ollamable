import type { CompactionPayload, Conversation, ConversationStep } from "@/src/types/chat";
import { createId } from "@/src/lib/chat";

export const COMPACTED_TITLE_SUFFIX = " (compacted)";

/** The text of a fork's `compaction` step: the summary, then the remaining work when the model gave any. */
export function compactionContent({ summary, remainingWork }: CompactionPayload): string {
  return remainingWork ? `${summary}\n\nRemaining work:\n${remainingWork}` : summary;
}

/**
 * The conversation a `compact_context` call forks off `original`: same model, provider, settings and
 * tools; the original's system steps and one `compaction` step as its whole history; a fresh
 * identity; no request records of its own yet (the original's describe requests the fork never made).
 * Pure: `original` is neither read from storage nor modified.
 */
export function buildFork(original: Conversation, payload: CompactionPayload, now = new Date()): Conversation {
  const timestamp = now.toISOString();
  const compactionStep: ConversationStep = {
    id: createId(),
    kind: "compaction",
    title: "Compaction",
    content: compactionContent(payload),
    createdAt: timestamp,
    expanded: true,
    model: original.model,
  };
  return {
    id: createId(),
    title: `${original.title}${COMPACTED_TITLE_SUFFIX}`,
    titleEdited: true,
    model: original.model,
    provider: original.provider,
    systemPrompt: original.systemPrompt,
    temperature: original.temperature,
    maxOutputTokens: original.maxOutputTokens,
    reasoningEffort: original.reasoningEffort,
    maxModelInvocations: original.maxModelInvocations,
    maxToolCalls: original.maxToolCalls,
    availableTools: original.availableTools,
    activeToolIds: original.activeToolIds,
    createdAt: timestamp,
    updatedAt: timestamp,
    steps: [...original.steps.filter((step) => step.kind === "system"), compactionStep],
    requestContexts: [],
    forkedFrom: { conversationId: original.id, stepId: payload.toolCallStepId },
  };
}

/** The app-event text of a harness step: the model was not told about it and never sees it. */
export function compactionHarnessText(forkTitle: string): string {
  return `Context compacted by the app \u2014 continued in \u201c${forkTitle}\u201d`;
}

/**
 * The step appended to the ORIGINAL once `fork` exists: a `meta` event (an app event, never an
 * assistant message) recording that the app took over, with the fork's id in `data` so the card
 * can link to it. It is not a wire step: `placeStepsForModel` omits it from every request.
 */
export function buildCompactionHarnessStep(fork: Conversation, now = new Date()): ConversationStep {
  const title = "Context compacted";
  const detail = compactionHarnessText(fork.title);
  return {
    id: createId(),
    kind: "meta",
    title,
    content: detail,
    createdAt: now.toISOString(),
    expanded: true,
    metaEvent: { kind: "compaction", title, detail, data: { forkConversationId: fork.id } },
  };
}

/**
 * The fork a compaction harness step points at, or undefined for any other step or a malformed one
 * (the recorded fork id must be a non-empty string).
 */
export function compactionHarnessForkId(step: ConversationStep): string | undefined {
  if (step.kind !== "meta" || step.metaEvent?.kind !== "compaction") return undefined;
  const id = step.metaEvent.data?.forkConversationId;
  return typeof id === "string" && id ? id : undefined;
}
