import { describe, expect, it } from "vitest";
import type { ConversationStep, StepKind } from "@/src/types/chat";
import {
  appendResponseSteps,
  insertMetaStep,
  mergeStreamingSteps,
  settleInterruptedSteps,
  upsertStableSteps,
} from "@/src/lib/stream-steps";

function step(id: string, kind: StepKind, content = "", extra: Partial<ConversationStep> = {}): ConversationStep {
  return { id, kind, title: kind, content, createdAt: "2026-01-01T00:00:00.000Z", ...extra };
}

const expandAll = () => true;
/** Mirrors the "collapse reasoning by default" preference. */
const collapseReasoning = (s: ConversationStep) => s.kind !== "reasoning";

function ids(steps: ConversationStep[]): string[] {
  return steps.map((s) => s.id);
}

const history = [step("sys", "system", "be brief"), step("u1", "user", "hi")];

describe("mergeStreamingSteps", () => {
  it("appends the partial response as in-flight steps after the stored ones", () => {
    const result = mergeStreamingSteps(history, [step("r", "reasoning", "hm"), step("a", "assistant", "He")], expandAll);
    expect(ids(result)).toEqual(["sys", "u1", "stream-r", "stream-a"]);
    expect(result[3].content).toBe("He");
  });

  it("replaces the previous in-flight steps instead of accumulating them", () => {
    const first = mergeStreamingSteps(history, [step("a", "assistant", "He")], expandAll);
    const second = mergeStreamingSteps(first, [step("a", "assistant", "Hello")], expandAll);
    expect(ids(second)).toEqual(["sys", "u1", "stream-a"]);
    expect(second[2].content).toBe("Hello");
  });

  it("keeps stable steps that arrived between deltas", () => {
    const withStable = [...history, step("tc", "tool_call"), step("tr", "tool_result", "{}"), step("stream-a", "assistant", "old")];
    const result = mergeStreamingSteps(withStable, [step("a", "assistant", "new")], expandAll);
    expect(ids(result)).toEqual(["sys", "u1", "tc", "tr", "stream-a"]);
    expect(result[4].content).toBe("new");
  });

  it("expands or collapses each in-flight step per the display preference", () => {
    const result = mergeStreamingSteps(history, [step("r", "reasoning", "hm"), step("a", "assistant", "x")], collapseReasoning);
    expect(result.slice(2).map((s) => s.expanded)).toEqual([false, true]);
  });

  it("splits a merged assistant step into its tool calls followed by its prose", () => {
    const merged = step("a", "assistant", "Let me check.", { toolCalls: [{ name: "curl", arguments: { url: "http://x" } }] });
    const result = mergeStreamingSteps(history, [merged], expandAll);
    expect(result.slice(2).map((s) => [s.id, s.kind])).toEqual([
      ["stream-a:tool:0", "tool_call"],
      ["stream-a", "assistant"],
    ]);
    expect(result[2].toolCall).toEqual({ name: "curl", arguments: { url: "http://x" } });
    expect(result[3].toolCalls).toBeUndefined();
  });
});

describe("upsertStableSteps", () => {
  it("drops the in-flight steps and appends the stable ones", () => {
    const current = [...history, step("stream-a", "assistant", "partial")];
    const result = upsertStableSteps(current, [step("tc", "tool_call", "", { toolCall: { name: "curl", arguments: {} } })], expandAll);
    expect(ids(result)).toEqual(["sys", "u1", "tc"]);
  });

  it("replaces a stored step with the same id (an in-progress tool result becoming final) and moves it to the end", () => {
    const current = [...history, step("tr", "tool_result", "running"), step("m", "meta")];
    const result = upsertStableSteps(current, [step("tr", "tool_result", "done")], expandAll);
    expect(ids(result)).toEqual(["sys", "u1", "m", "tr"]);
    expect(result[3].content).toBe("done");
  });

  it("applies the display preference to the new steps only", () => {
    const current = [step("r0", "reasoning", "old", { expanded: true })];
    const result = upsertStableSteps(current, [step("r1", "reasoning", "new")], collapseReasoning);
    expect(result.map((s) => s.expanded)).toEqual([true, false]);
  });
});

describe("insertMetaStep", () => {
  it("inserts a server event above the in-flight response", () => {
    const current = [...history, step("stream-r", "reasoning"), step("stream-a", "assistant")];
    const result = insertMetaStep(current, step("meta-1", "meta"), expandAll);
    expect(ids(result)).toEqual(["sys", "u1", "meta-1", "stream-r", "stream-a"]);
  });

  it("appends the event when nothing is in flight", () => {
    expect(ids(insertMetaStep(history, step("meta-1", "meta"), expandAll))).toEqual(["sys", "u1", "meta-1"]);
  });

  it("does not mutate the steps it was given", () => {
    const current = [...history];
    insertMetaStep(current, step("meta-1", "meta"), expandAll);
    expect(ids(current)).toEqual(["sys", "u1"]);
  });

  it("collapses the event when server messages are collapsed by default", () => {
    const result = insertMetaStep(history, step("meta-1", "meta"), (s) => s.kind !== "meta");
    expect(result[2].expanded).toBe(false);
  });
});

describe("appendResponseSteps", () => {
  it("replaces the in-flight steps with the final response", () => {
    const current = [...history, step("stream-a", "assistant", "partial")];
    const result = appendResponseSteps(current, [step("a", "assistant", "complete")], expandAll);
    expect(ids(result)).toEqual(["sys", "u1", "a"]);
    expect(result[2].content).toBe("complete");
  });

  it("does not duplicate steps already stored as stable during the tool loop", () => {
    const current = [...history, step("tc", "tool_call"), step("tr", "tool_result", "stored")];
    const result = appendResponseSteps(
      current,
      [step("tc", "tool_call"), step("tr", "tool_result", "resent"), step("a", "assistant", "answer")],
      expandAll
    );
    expect(ids(result)).toEqual(["sys", "u1", "tc", "tr", "a"]);
    expect(result[3].content).toBe("stored");
  });

  it("applies the display preference to the appended steps", () => {
    const result = appendResponseSteps(history, [step("r", "reasoning", "hm"), step("a", "assistant", "x")], collapseReasoning);
    expect(result.slice(2).map((s) => s.expanded)).toEqual([false, true]);
  });
});

describe("settleInterruptedSteps", () => {
  const inFlight = [
    ...history,
    step("stream-r", "reasoning", "thinking so far"),
    step("stream-tc", "tool_call", "", { toolCall: { name: "curl", arguments: {} } }),
    step("stream-a", "assistant", "partial answer", { toolCalls: [{ name: "curl", arguments: {} }] }),
    step("stream-empty", "assistant", "  "),
  ];

  it("drops every in-flight step when the user stopped or the request failed", () => {
    expect(ids(settleInterruptedSteps(inFlight, false))).toEqual(["sys", "u1"]);
  });

  it("after a lost connection, keeps partial reasoning and assistant prose under a new id", () => {
    const result = settleInterruptedSteps(inFlight, true);
    expect(ids(result)).toEqual(["sys", "u1", "interrupted-r", "interrupted-a"]);
    expect(result[3].content).toBe("partial answer");
  });

  it("strips the unfinished tool call from kept prose, so it is never sent back as a completed call", () => {
    const kept = settleInterruptedSteps(inFlight, true).find((s) => s.id === "interrupted-a");
    expect(kept?.toolCall).toBeUndefined();
    expect(kept?.toolCalls).toBeUndefined();
  });

  it("leaves stored steps untouched either way", () => {
    expect(settleInterruptedSteps(history, true)).toEqual(history);
    expect(settleInterruptedSteps(history, false)).toEqual(history);
  });
});
