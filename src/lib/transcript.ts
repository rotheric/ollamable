import type { ConversationStep, ToolCallPayload } from "@/src/types/chat";

export function isVisibleTranscriptStep(step: ConversationStep) {
  return (
    step.kind === "user" ||
    (step.kind === "assistant" && Boolean(step.content.trim())) ||
    step.kind === "tool_call" ||
    step.kind === "reasoning" ||
    step.kind === "tool_result" ||
    step.kind === "meta"
  );
}

/** Thread depth for visual nesting. Level 0 = no bar, 1 = one bar, 2 = two bars. */
export function stepThreadDepth(kind: ConversationStep["kind"]): number {
  switch (kind) {
    case "reasoning":
    case "tool_call":
    case "tool_result":
      return 1;
    case "meta":
      return 2;
    default:
      return 0;
  }
}

export function formatStepHeader(step: ConversationStep): string {
  if (step.kind === "tool_result") {
    return "tool call response";
  }
  if (step.kind === "meta" && step.metaEvent) {
    const kind = step.metaEvent.kind;
    if (kind === "mcp_call") {
      const tool = (step.metaEvent.data?.tool as string) ?? "";
      return `Server Execution${tool ? `: ${tool}` : ""}`;
    }
    if (kind === "mcp_result") {
      const tool = (step.metaEvent.data?.tool as string) ?? "";
      return `Server Result${tool ? `: ${tool}` : ""}`;
    }
    return step.metaEvent.kind.replace(/_/g, " ");
  }
  return step.kind.replace("_", " ");
}

export function formatStepFooterMeta(step: ConversationStep): string | null {
  const parts: string[] = [];
  if (step.interrupted) parts.push("interrupted");

  if (step.model && (step.kind === "assistant" || step.kind === "reasoning")) {
    parts.push(step.model);
  }

  if (step.kind === "meta" && step.metaEvent?.kind === "search_result" && step.content) {
    parts.push(step.content);
  } else if (step.kind === "meta" && step.metaEvent?.durationMs != null) {
    parts.push(`${step.metaEvent.durationMs}ms`);
  }

  if (step.usage) {
    if (step.usage.inputTokens != null) parts.push(`in: ${step.usage.inputTokens.toLocaleString()}`);
    if (step.usage.outputTokens != null) parts.push(`out: ${step.usage.outputTokens.toLocaleString()}`);
    if (step.usage.stopReason) parts.push(`stop: ${step.usage.stopReason}`);
  }

  return parts.length > 0 ? parts.join(" / ") : null;
}

/** Index of the first step of the response that `assistantIndex` belongs to. */
export function findResponseStartIndex(steps: ConversationStep[], assistantIndex: number) {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const step = steps[index];

    if (step.kind === "user" || step.kind === "system" || step.kind === "tool_result") {
      return index + 1;
    }
  }

  return 0;
}

export function prettyPrintJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The last chat message (user or assistant); only this one offers "Delete message". */
export function findLastDeletableStepIndex(steps: ConversationStep[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "user" || steps[i].kind === "assistant") {
      return i;
    }
  }
  return -1;
}

/**
 * Where to cut the transcript when the last exchange is deleted, or -1 when
 * there is nothing to delete. A trailing user message is removed on its own;
 * a trailing assistant message takes its whole response with it (reasoning,
 * tool activity) but keeps the user message that prompted it.
 */
export function deleteLastExchangeCutIndex(steps: ConversationStep[]): number {
  const lastDeletableIndex = findLastDeletableStepIndex(steps);
  if (lastDeletableIndex === -1) {
    return -1;
  }

  if (steps[lastDeletableIndex].kind === "user") {
    return lastDeletableIndex;
  }

  for (let i = lastDeletableIndex - 1; i >= 0; i--) {
    if (steps[i].kind === "user") {
      return i + 1;
    }
    if (steps[i].kind === "system") {
      break;
    }
  }
  return lastDeletableIndex;
}

export interface TranscriptItem {
  step: ConversationStep;
  /** Set on the first visible step of each kind, so the guided tour has one target per kind. */
  dataTour?: string;
  /** Tool calls requested by this step, in either the standalone or the legacy merged shape. */
  toolCalls: ToolCallPayload[];
  /** Tool calls requested in the transcript up to and including this step. */
  cumulativeToolCalls: number;
}

const STEP_TOUR_TARGETS: Record<string, string> = {
  user: "step-user",
  assistant: "step-assistant",
  reasoning: "step-reasoning",
  tool_call: "step-tool-call",
  tool_result: "step-tool-result",
  meta: "step-meta",
};

/** Derives the per-step facts that depend on a step's position in the transcript. */
export function annotateTranscriptSteps(steps: ConversationStep[]): TranscriptItem[] {
  const seenKinds = new Set<string>();
  let cumulativeToolCalls = 0;
  return steps.map((step) => {
    let dataTour: string | undefined;
    if (!seenKinds.has(step.kind)) {
      seenKinds.add(step.kind);
      dataTour = STEP_TOUR_TARGETS[step.kind];
    }
    const toolCalls = step.toolCall ? [step.toolCall] : step.toolCalls ?? [];
    cumulativeToolCalls += toolCalls.length;
    return { step, dataTour, toolCalls, cumulativeToolCalls };
  });
}
