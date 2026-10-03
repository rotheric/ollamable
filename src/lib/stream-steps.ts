import { normalizeResponseSteps } from "../../shared/normalize-response-steps";
import type { ConversationStep } from "@/src/types/chat";

/**
 * How a streamed response is folded into a conversation's steps.
 *
 * While a response is in flight its steps carry a `stream-` id prefix and are
 * replaced wholesale by every delta. Steps the server declares stable (tool
 * calls and results between model invocations) and the final response keep
 * their own ids. Nothing here manufactures assistant content: steps are only
 * placed, replaced or dropped.
 */

const STREAM_PREFIX = "stream-";

type DefaultExpanded = (step: ConversationStep) => boolean;

/** True for an in-flight (still streaming) step. */
export function isStreamingStep(step: Pick<ConversationStep, "id">): boolean {
  return step.id.startsWith(STREAM_PREFIX);
}

/** Replaces the in-flight steps with the latest partial response. */
export function mergeStreamingSteps(
  steps: ConversationStep[],
  partialSteps: ConversationStep[],
  defaultExpanded: DefaultExpanded
): ConversationStep[] {
  const stableSteps = steps.filter((step) => !isStreamingStep(step));
  const nextStreamingSteps = normalizeResponseSteps(partialSteps).map((step) => ({
    ...step,
    id: `${STREAM_PREFIX}${step.id}`,
    expanded: defaultExpanded(step),
  }));
  return [...stableSteps, ...nextStreamingSteps];
}

/** Drops the in-flight steps and upserts steps the server declared stable, by id. */
export function upsertStableSteps(
  steps: ConversationStep[],
  newSteps: ConversationStep[],
  defaultExpanded: DefaultExpanded
): ConversationStep[] {
  const normalized = normalizeResponseSteps(newSteps);
  const newStepIds = new Set(normalized.map((step) => step.id));
  const existing = steps.filter((step) => !isStreamingStep(step) && !newStepIds.has(step.id));
  return [...existing, ...normalized.map((step) => ({ ...step, expanded: defaultExpanded(step) }))];
}

/** Inserts a meta step before the in-flight steps, so it appears above the current stream. */
export function insertMetaStep(
  steps: ConversationStep[],
  metaStep: ConversationStep,
  defaultExpanded: DefaultExpanded
): ConversationStep[] {
  const streamingIdx = steps.findIndex(isStreamingStep);
  const insertIdx = streamingIdx === -1 ? steps.length : streamingIdx;
  const nextSteps = [...steps];
  nextSteps.splice(insertIdx, 0, { ...metaStep, expanded: defaultExpanded(metaStep) });
  return nextSteps;
}

/** Replaces the in-flight steps with the final response, skipping steps already stored as stable. */
export function appendResponseSteps(
  steps: ConversationStep[],
  responseSteps: ConversationStep[],
  defaultExpanded: DefaultExpanded
): ConversationStep[] {
  const stableSteps = steps.filter((step) => !isStreamingStep(step));
  const existingIds = new Set(stableSteps.map((step) => step.id));
  const newSteps = normalizeResponseSteps(responseSteps)
    .filter((step) => !existingIds.has(step.id))
    .map((step) => ({ ...step, expanded: defaultExpanded(step) }));
  return [...stableSteps, ...newSteps];
}

/**
 * Settles the in-flight steps of a response that will not complete. They are
 * dropped, except after a lost connection: there, partial assistant and
 * reasoning prose is kept, without its unfinished protocol tool call.
 */
export function settleInterruptedSteps(
  steps: ConversationStep[],
  keepPartialProse: boolean
): ConversationStep[] {
  return steps.flatMap((step) => {
    if (!isStreamingStep(step)) return [step];
    if (!keepPartialProse || !step.content.trim() || !["assistant", "reasoning"].includes(step.kind)) return [];
    return [{ ...step, id: step.id.replace(/^stream-/, "interrupted-"), toolCall: undefined, toolCalls: undefined }];
  });
}
