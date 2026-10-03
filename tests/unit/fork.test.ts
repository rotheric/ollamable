/**
 * The fork's record and its supporting model (epic-compaction-tool S6): construction (AC-FORK-1..3),
 * stability across reload, sidebar visibility (AC-FORK-5), transcript turn boundaries (AC-FORK-12)
 * and the wire form through the real formatters (AC-FORK-10).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildCompactionHarnessStep, buildFork, compactionHarnessForkId, compactionContent, compactionHarnessText } from "@/src/lib/fork";
import { createConversation, createStep, ensureSystemPromptStep, inferTitle } from "@/src/lib/chat";
import { orderVisibleConversations } from "@/src/lib/use-conversations";
import { appendResponseSteps } from "@/src/lib/stream-steps";
import {
  deleteLastExchangeCutIndex,
  findLastDeletableStepIndex,
  findResponseStartIndex,
  formatStepHeader,
  isVisibleTranscriptStep,
} from "@/src/lib/transcript";
import { CONTEXT_PLACEMENT, placeStepsForModel } from "@/shared/context-usage";
import { toOllamaMessages } from "@/shared/ollama-format";
import { toOpenAIMessages } from "@/shared/openai-format";
import type { CompactionPayload, Conversation, ConversationStep } from "@/src/types/chat";

const TOOL = { id: "compact-context", name: "compact_context", description: "d", inputSchema: "{}" };
const payload: CompactionPayload = { toolCallStepId: "tc-1", summary: "THE SUMMARY", remainingWork: "THE REMAINING WORK" };

function original(): Conversation {
  const base = createConversation("qwen3:latest", [TOOL], "ollama");
  return {
    ...base,
    title: "Original",
    systemPrompt: "be terse",
    temperature: 0.2,
    maxOutputTokens: 100,
    reasoningEffort: "low",
    maxModelInvocations: 3,
    maxToolCalls: 4,
    activeToolIds: [TOOL.id],
    steps: [{ ...base.steps[0], content: "be terse" }, createStep("user", "User", "hi"), createStep("assistant", "Assistant", "yo")],
    requestContexts: [{ startIndex: 2, compactEnabled: true, modelFamily: "qwen" }],
  };
}

describe("buildFork", () => {
  it("copies the settings and tools, titles the fork and links it to the original's tool_call step", () => {
    const source = original();
    const fork = buildFork(source, payload);
    expect(fork.forkedFrom).toEqual({ conversationId: source.id, stepId: "tc-1" });
    expect(fork.title).toBe("Original (compacted)");
    expect(fork.titleEdited).toBe(true);
    for (const key of ["model", "provider", "systemPrompt", "temperature", "maxOutputTokens", "reasoningEffort", "maxModelInvocations", "maxToolCalls", "availableTools", "activeToolIds"] as const) {
      expect(fork[key], key).toEqual(source[key]);
    }
    expect(fork.id).not.toBe(source.id);
  });

  it("holds exactly the original's system step followed by one compaction step with summary and remaining work", () => {
    const source = original();
    const fork = buildFork(source, payload);
    expect(fork.steps).toHaveLength(2);
    expect(fork.steps[0]).toEqual(source.steps[0]);
    expect(fork.steps[1].kind).toBe("compaction");
    expect(fork.steps[1].content).toContain("THE SUMMARY");
    expect(fork.steps[1].content).toContain("THE REMAINING WORK");
    expect(fork.steps[1].model).toBe("qwen3:latest");
  });

  it("omits the remaining-work section when there is none", () => {
    expect(compactionContent({ toolCallStepId: "x", summary: "S" })).toBe("S");
    expect(buildFork(original(), { toolCallStepId: "x", summary: "S" }).steps[1].content).toBe("S");
  });

  it("starts without request records (the original's describe requests the fork never made) and does not touch the original", () => {
    const source = original();
    const snapshot = structuredClone(source);
    const fork = buildFork(source, payload);
    expect(fork.requestContexts).toEqual([]);
    expect(source).toEqual(snapshot);
  });

  it("survives a reload unchanged: ensureSystemPromptStep keeps the single system step and the compaction at their indices", () => {
    const fork = buildFork(original(), payload);
    const reloaded = ensureSystemPromptStep(JSON.parse(JSON.stringify(fork)) as Conversation);
    expect(reloaded.steps.map((s) => s.kind)).toEqual(["system", "compaction"]);
    expect(reloaded.steps[1]).toEqual(fork.steps[1]);
    expect(reloaded.forkedFrom).toEqual(fork.forkedFrom);
  });

  it("keeps its title when the user later sends (titleEdited gates inferTitle in the send path)", () => {
    const fork = buildFork(original(), payload);
    // inferTitle itself would rename it; the workspace only calls it for conversations that are not titleEdited.
    expect(fork.titleEdited).toBe(true);
    expect(inferTitle([...fork.steps, createStep("user", "User", "next")])).toBe("next");
  });
});

describe("the compaction target in the stored original", () => {
  it("toolCallStepId still identifies a tool_call step after the response steps are applied and normalised", () => {
    const toolCall: ConversationStep = {
      id: "tc-1", kind: "tool_call", title: "Tool Call", content: "", createdAt: "t",
      toolCall: { id: "call-1", name: "compact_context", arguments: { summary: "S" } },
    };
    const toolResult: ConversationStep = { id: "tr-1", kind: "tool_result", title: "Tool Result", content: "ok", createdAt: "t", toolResult: { id: "call-1", name: "compact_context" } };
    const stored = appendResponseSteps(original().steps, [toolCall, toolResult], () => false);
    const reloaded = ensureSystemPromptStep({ ...original(), steps: stored }).steps;
    for (const steps of [stored, reloaded]) {
      expect(steps.find((s) => s.id === "tc-1")?.kind).toBe("tool_call");
    }
  });
});

describe("sidebar visibility (AC-FORK-5)", () => {
  it("lists a conversation with a compaction step and not an empty one", () => {
    const fork = buildFork(original(), payload);
    const empty = createConversation("m", [], "ollama");
    expect(orderVisibleConversations([empty, fork], null)).toEqual([fork]);
    expect(orderVisibleConversations([empty, fork], [fork.id])).toEqual([fork]);
  });
});

describe("transcript with a compaction step (AC-FORK-12)", () => {
  const sys = createStep("system", "System Prompt", "");
  const compaction = createStep("compaction", "Compaction", "S");
  const assistant = (content: string) => createStep("assistant", "Assistant", content);
  const user = createStep("user", "User", "q");

  it("is visible, and labelled with the authoring model and compact_context", () => {
    expect(isVisibleTranscriptStep(compaction)).toBe(true);
    expect(formatStepHeader({ ...compaction, model: "qwen3:latest" })).toBe("written by qwen3:latest via compact_context");
  });

  it("is a response boundary: regenerating the fork's first response keeps it", () => {
    const steps = [sys, compaction, assistant("first")];
    expect(findResponseStartIndex(steps, 2)).toBe(2);
    expect(steps.slice(0, findResponseStartIndex(steps, 2)).map((s) => s.kind)).toEqual(["system", "compaction"]);
    const withTools = [sys, compaction, createStep("tool_call", "Tool Call", ""), createStep("tool_result", "R", ""), assistant("first")];
    expect(findResponseStartIndex(withTools, 4)).toBe(4);
    const noToolResult = [sys, compaction, createStep("reasoning", "r", "x"), createStep("tool_call", "Tool Call", ""), assistant("first")];
    expect(findResponseStartIndex(noToolResult, 4)).toBe(2);
  });

  it("deleting the fork's last exchange keeps the compaction step, and the compaction is never the deletable message", () => {
    const steps = [sys, compaction, createStep("reasoning", "r", "x"), assistant("first")];
    expect(deleteLastExchangeCutIndex(steps)).toBe(2);
    expect(steps.slice(0, deleteLastExchangeCutIndex(steps)).map((s) => s.kind)).toEqual(["system", "compaction"]);

    const afterUser = [sys, compaction, assistant("first"), user, assistant("second")];
    expect(deleteLastExchangeCutIndex(afterUser)).toBe(4);
    expect(deleteLastExchangeCutIndex([sys, compaction, assistant("first"), user])).toBe(3);

    expect(findLastDeletableStepIndex([sys, compaction])).toBe(-1);
    expect(deleteLastExchangeCutIndex([sys, compaction])).toBe(-1);
  });
});

describe("wire form of a fork (AC-FORK-10)", () => {
  const families = [undefined, ...Object.keys(CONTEXT_PLACEMENT.exceptions)];

  it("puts the summary into both providers' messages, and never two user messages in a row", () => {
    // A well-formed continuation: the user and the model alternate, starting with the user (or nothing yet).
    const stepKinds = fc.integer({ min: 0, max: 5 }).map((n) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? "user" : "assistant")));
    fc.assert(
      fc.property(stepKinds, fc.boolean(), fc.constantFrom(...families), (tail, compactEnabled, family) => {
        const fork = buildFork(original(), payload);
        const steps = [...fork.steps, ...tail.map((kind) => createStep(kind, kind, `${kind}-text`))];
        const placed = placeStepsForModel(steps, { compactEnabled, usedTokens: undefined, family });
        for (const messages of [toOllamaMessages(placed), toOpenAIMessages(placed)] as Array<Array<{ role: string; content?: unknown }>>) {
          expect(messages.some((m) => typeof m.content === "string" && m.content.includes("THE SUMMARY"))).toBe(true);
          expect(messages.some((m) => typeof m.content === "string" && m.content.includes("THE REMAINING WORK"))).toBe(true);
          messages.slice(1).forEach((m, i) => {
            expect(m.role === "user" && messages[i].role === "user").toBe(false);
          });
        }
        // Placement is a copy: the stored steps keep their compaction kind.
        expect(steps[1].kind).toBe("compaction");
      })
    );
  });
});

describe("compaction harness step (AC-FORK-4 / AC-FORK-14)", () => {
  const input = { compactEnabled: false, usedTokens: undefined };
  const call = (id: string | undefined, name = "compact_context"): ConversationStep => ({
    ...createStep("tool_call", "Tool Call", ""),
    toolCall: { ...(id === undefined ? {} : { id }), name, arguments: {} },
  });
  const result = (id: string | undefined, name = "compact_context"): ConversationStep => ({
    ...createStep("tool_result", "Result", "{}"),
    toolResult: { ...(id === undefined ? {} : { id }), name },
  });
  const ids = (steps: ConversationStep[]) => steps.map((s) => s.id);

  it("is a meta event step, not an assistant message, carrying the fork's real id and title", () => {
    const fork = buildFork(original(), payload);
    const step = buildCompactionHarnessStep(fork);
    expect(step.kind).toBe("meta");
    expect(step.metaEvent).toEqual({
      kind: "compaction",
      title: step.title,
      detail: compactionHarnessText(fork.title),
      data: { forkConversationId: fork.id },
    });
    expect(step.content).toBe(`Context compacted by the app \u2014 continued in \u201c${fork.title}\u201d`);
    expect(buildCompactionHarnessStep(buildFork(original(), payload)).metaEvent!.data!.forkConversationId).not.toBe(fork.id);
  });

  it("placeStepsForModel omits the harness step and an unanswered compact_context call (same id)", () => {
    const harness = buildCompactionHarnessStep(buildFork(original(), payload));
    const kept = createStep("user", "User", "q");
    const dangling = call("c1");
    expect(ids(placeStepsForModel([kept, dangling, harness], input))).toEqual([kept.id]);
  });

  it("matches by id: another call's result does not answer it; a same-id result does", () => {
    const dangling = call("c1");
    expect(placeStepsForModel([dangling, result("c2")], input).map((s) => s.kind)).toEqual(["tool_result"]);
    const answered = placeStepsForModel([dangling, result("c1")], input);
    expect(answered.map((s) => s.kind)).toEqual(["tool_call", "tool_result"]);
  });

  it("id-less calls match a same-name result AFTER them only", () => {
    const dangling = call(undefined);
    expect(placeStepsForModel([dangling, result(undefined)], input).map((s) => s.kind)).toEqual(["tool_call", "tool_result"]);
    expect(placeStepsForModel([result(undefined), dangling], input).map((s) => s.kind)).toEqual(["tool_result"]);
    expect(placeStepsForModel([dangling, result(undefined, "web_search")], input).map((s) => s.kind)).toEqual(["tool_result"]);
  });

  it("id-less: a later turn's rejected compact_context result never resurrects an earlier honoured call", () => {
    const honoured = call(undefined);
    const harness = buildCompactionHarnessStep(buildFork(original(), payload));
    const user = createStep("user", "User", "continue");
    const rejected = call(undefined);
    const search = call(undefined, "web_search");
    const rejectedResult = result(undefined);
    const searchResult = result(undefined, "web_search");
    const placed = placeStepsForModel([honoured, harness, user, rejected, search, rejectedResult, searchResult], input);
    expect(ids(placed)).toEqual([user.id, rejected.id, search.id, rejectedResult.id, searchResult.id]);
  });

  it("never drops other tools' calls and does not mutate its input", () => {
    const search = call("s1", "web_search");
    const steps = [search, call("c1"), buildCompactionHarnessStep(buildFork(original(), payload))];
    const copy = structuredClone(steps);
    expect(placeStepsForModel(steps, input)).toEqual([search]);
    expect(steps).toEqual(copy);
  });

  it("the wire form of a compacted original has no compact_context call and no harness text (both formatters)", () => {
    const fork = buildFork(original(), payload);
    const steps = [createStep("user", "User", "q"), call("c1"), buildCompactionHarnessStep(fork), createStep("user", "User", "next")];
    const placed = placeStepsForModel(steps, input);
    for (const wire of [JSON.stringify(toOllamaMessages(placed)), JSON.stringify(toOpenAIMessages(placed))]) {
      expect(wire).not.toContain("compact_context");
      expect(wire).not.toContain("Context compacted by the app");
    }
  });
});

describe("compactionHarnessForkId", () => {
  const harness = (data: Record<string, unknown> | undefined): ConversationStep => ({
    ...createStep("meta", "Context compacted", "x"),
    metaEvent: { kind: "compaction", title: "t", detail: "d", ...(data ? { data } : {}) },
  });

  it("returns the fork id of a harness step", () => {
    expect(compactionHarnessForkId(harness({ forkConversationId: "f1" }))).toBe("f1");
  });

  it("returns undefined for an empty, missing or non-string fork id", () => {
    expect(compactionHarnessForkId(harness({ forkConversationId: "" }))).toBeUndefined();
    expect(compactionHarnessForkId(harness({ forkConversationId: 7 }))).toBeUndefined();
    expect(compactionHarnessForkId(harness(undefined))).toBeUndefined();
  });

  it("returns undefined for other steps and other meta events", () => {
    expect(compactionHarnessForkId(createStep("user", "User", "q"))).toBeUndefined();
    const other = createStep("meta", "m", "x");
    expect(compactionHarnessForkId({ ...other, metaEvent: { kind: "mcp_call", title: "t", detail: "d", data: { forkConversationId: "f1" } } })).toBeUndefined();
  });
});
