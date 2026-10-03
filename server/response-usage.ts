import type { ConversationStep, UsagePayload } from "./types.js";

/** Keep invocation accounting exactly once, independently of assistant prose. */
export function retainResponseUsage(
  steps: ConversationStep[],
  usage: UsagePayload | undefined,
  source: Pick<ConversationStep, "id" | "createdAt">,
): ConversationStep[] {
  if (!usage) return steps;
  const target = steps.find((step) => step.kind === "assistant") ?? steps[0];
  if (target) {
    target.usage = usage;
    return steps;
  }
  // An empty response that reported nothing has no fields to retain: no content-free meta step.
  if (Object.keys(usage).length === 0) return steps;
  return [{ ...source, kind: "meta", title: "Model usage", content: "", expanded: false, usage }];
}
