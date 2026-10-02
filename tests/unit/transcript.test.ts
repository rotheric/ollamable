import { describe, expect, it } from "vitest";
import type { ConversationStep, StepKind } from "@/src/types/chat";
import {
  annotateTranscriptSteps,
  deleteLastExchangeCutIndex,
  findLastDeletableStepIndex,
  findResponseStartIndex,
  formatStepFooterMeta,
  formatStepHeader,
  isVisibleTranscriptStep,
  prettyPrintJson,
  stepThreadDepth,
} from "@/src/lib/transcript";

let nextId = 0;
function step(kind: StepKind, content = "text", extra: Partial<ConversationStep> = {}): ConversationStep {
  nextId += 1;
  return { id: `s${nextId}`, kind, title: kind, content, createdAt: "2026-01-01T00:00:00.000Z", ...extra };
}

function kinds(steps: ConversationStep[]): StepKind[] {
  return steps.map((s) => s.kind);
}

describe("isVisibleTranscriptStep", () => {
  it("shows chat messages and protocol activity, but not the system step (it has its own field)", () => {
    expect(isVisibleTranscriptStep(step("user"))).toBe(true);
    expect(isVisibleTranscriptStep(step("reasoning"))).toBe(true);
    expect(isVisibleTranscriptStep(step("tool_call"))).toBe(true);
    expect(isVisibleTranscriptStep(step("tool_result"))).toBe(true);
    expect(isVisibleTranscriptStep(step("meta"))).toBe(true);
    expect(isVisibleTranscriptStep(step("system"))).toBe(false);
  });

  it("hides an assistant step that carries no prose", () => {
    expect(isVisibleTranscriptStep(step("assistant", "answer"))).toBe(true);
    expect(isVisibleTranscriptStep(step("assistant", ""))).toBe(false);
    expect(isVisibleTranscriptStep(step("assistant", " \n "))).toBe(false);
  });
});

describe("stepThreadDepth", () => {
  it("nests protocol activity one level and server events two levels under the chat messages", () => {
    expect(stepThreadDepth("user")).toBe(0);
    expect(stepThreadDepth("assistant")).toBe(0);
    expect(stepThreadDepth("system")).toBe(0);
    expect(stepThreadDepth("reasoning")).toBe(1);
    expect(stepThreadDepth("tool_call")).toBe(1);
    expect(stepThreadDepth("tool_result")).toBe(1);
    expect(stepThreadDepth("meta")).toBe(2);
  });
});

describe("formatStepHeader", () => {
  it("names a step by its kind, with underscores read as spaces", () => {
    expect(formatStepHeader(step("user"))).toBe("user");
    expect(formatStepHeader(step("tool_call"))).toBe("tool call");
  });

  it("calls a tool result a tool call response", () => {
    expect(formatStepHeader(step("tool_result"))).toBe("tool call response");
  });

  it("names MCP executions and results after the tool they concern", () => {
    const call = step("meta", "", { metaEvent: { kind: "mcp_call", title: "", detail: "", data: { tool: "browser_navigate" } } });
    const result = step("meta", "", { metaEvent: { kind: "mcp_result", title: "", detail: "", data: { tool: "browser_navigate" } } });
    expect(formatStepHeader(call)).toBe("Server Execution: browser_navigate");
    expect(formatStepHeader(result)).toBe("Server Result: browser_navigate");
  });

  it("omits the tool suffix when an MCP event names no tool", () => {
    expect(formatStepHeader(step("meta", "", { metaEvent: { kind: "mcp_call", title: "", detail: "" } }))).toBe("Server Execution");
    expect(formatStepHeader(step("meta", "", { metaEvent: { kind: "mcp_result", title: "", detail: "" } }))).toBe("Server Result");
  });

  it("names other server events by their event kind, replacing every underscore", () => {
    expect(formatStepHeader(step("meta", "", { metaEvent: { kind: "search_result", title: "", detail: "" } }))).toBe("search result");
    expect(formatStepHeader(step("meta"))).toBe("meta");
  });
});

describe("formatStepFooterMeta", () => {
  it("is null when there is nothing to report", () => {
    expect(formatStepFooterMeta(step("user"))).toBeNull();
  });

  it("lists interruption, model, token usage and stop reason, in that order", () => {
    const assistant = step("assistant", "hi", {
      interrupted: true,
      model: "qwen3:latest",
      usage: { inputTokens: 1234, outputTokens: 56, stopReason: "stop" },
    });
    expect(formatStepFooterMeta(assistant)).toBe(
      `interrupted / qwen3:latest / in: ${(1234).toLocaleString()} / out: 56 / stop: stop`
    );
  });

  it("names the model only on steps the model authored", () => {
    expect(formatStepFooterMeta(step("reasoning", "hm", { model: "m" }))).toBe("m");
    expect(formatStepFooterMeta(step("tool_result", "{}", { model: "m" }))).toBeNull();
    expect(formatStepFooterMeta(step("user", "q", { model: "m" }))).toBeNull();
  });

  it("reports only the usage figures that are present, including zero", () => {
    expect(formatStepFooterMeta(step("meta", "", { usage: { outputTokens: 0 } }))).toBe("out: 0");
    expect(formatStepFooterMeta(step("meta", "", { usage: { inputTokens: 7 } }))).toBe("in: 7");
  });

  it("shows a search result's summary, and a duration for other timed server events", () => {
    const search = step("meta", "3 results", { metaEvent: { kind: "search_result", title: "", detail: "", durationMs: 40 } });
    const fetched = step("meta", "ignored", { metaEvent: { kind: "fetch_result", title: "", detail: "", durationMs: 120 } });
    expect(formatStepFooterMeta(search)).toBe("3 results");
    expect(formatStepFooterMeta(fetched)).toBe("120ms");
  });

  it("falls back to the duration for a search result without a summary", () => {
    const search = step("meta", "", { metaEvent: { kind: "search_result", title: "", detail: "", durationMs: 0 } });
    expect(formatStepFooterMeta(search)).toBe("0ms");
  });
});

describe("findResponseStartIndex", () => {
  it("starts the response right after the user message that prompted it", () => {
    const steps = [step("system"), step("user"), step("reasoning"), step("assistant")];
    expect(findResponseStartIndex(steps, 3)).toBe(2);
  });

  it("starts after the latest tool result, so regenerating keeps completed tool work", () => {
    const steps = [step("system"), step("user"), step("tool_call"), step("tool_result"), step("reasoning"), step("assistant")];
    expect(findResponseStartIndex(steps, 5)).toBe(4);
  });

  it("starts after the system step when no user message precedes the response", () => {
    expect(findResponseStartIndex([step("system"), step("assistant")], 1)).toBe(1);
  });

  it("is 0 when nothing precedes the response", () => {
    expect(findResponseStartIndex([step("reasoning"), step("assistant")], 1)).toBe(0);
    expect(findResponseStartIndex([step("assistant")], 0)).toBe(0);
  });
});

describe("prettyPrintJson", () => {
  it("re-indents valid JSON and leaves anything else untouched", () => {
    expect(prettyPrintJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyPrintJson("plain text result")).toBe("plain text result");
  });
});

describe("findLastDeletableStepIndex", () => {
  it("finds the last chat message, skipping trailing protocol activity", () => {
    expect(findLastDeletableStepIndex([step("system"), step("user"), step("assistant"), step("meta")])).toBe(2);
    expect(findLastDeletableStepIndex([step("system"), step("user"), step("tool_call"), step("tool_result")])).toBe(1);
  });

  it("is -1 when the conversation has no chat message yet", () => {
    expect(findLastDeletableStepIndex([step("system")])).toBe(-1);
    expect(findLastDeletableStepIndex([])).toBe(-1);
  });
});

describe("deleteLastExchangeCutIndex", () => {
  function remaining(steps: ConversationStep[]): StepKind[] {
    return kinds(steps.slice(0, deleteLastExchangeCutIndex(steps)));
  }

  it("is -1 when there is nothing to delete", () => {
    expect(deleteLastExchangeCutIndex([step("system")])).toBe(-1);
  });

  it("removes an unanswered user message on its own", () => {
    expect(remaining([step("system"), step("user"), step("assistant"), step("user")])).toEqual(["system", "user", "assistant"]);
  });

  it("removes a trailing response with its reasoning and tool activity, keeping the user message", () => {
    const steps = [
      step("system"), step("user"), step("assistant"),
      step("user"), step("reasoning"), step("tool_call"), step("tool_result"), step("assistant"),
    ];
    expect(remaining(steps)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("also drops protocol steps that trail the removed message", () => {
    expect(remaining([step("system"), step("user"), step("assistant"), step("meta")])).toEqual(["system", "user"]);
  });

  it("removes only the assistant message when no user message precedes it", () => {
    expect(remaining([step("system"), step("reasoning"), step("assistant")])).toEqual(["system", "reasoning"]);
  });
});

describe("annotateTranscriptSteps", () => {
  it("marks only the first step of each kind as a tour target", () => {
    const items = annotateTranscriptSteps([step("user"), step("assistant"), step("user"), step("assistant")]);
    expect(items.map((item) => item.dataTour)).toEqual(["step-user", "step-assistant", undefined, undefined]);
  });

  it("gives every transcript kind its own tour target", () => {
    const items = annotateTranscriptSteps([step("reasoning"), step("tool_call"), step("tool_result"), step("meta")]);
    expect(items.map((item) => item.dataTour)).toEqual(["step-reasoning", "step-tool-call", "step-tool-result", "step-meta"]);
  });

  it("reads tool calls from the standalone shape and from the legacy merged shape", () => {
    const standalone = step("tool_call", "", { toolCall: { name: "curl", arguments: { url: "http://a" } } });
    const merged = step("assistant", "prose", { toolCalls: [{ name: "a", arguments: {} }, { name: "b", arguments: {} }] });
    const [first, second] = annotateTranscriptSteps([standalone, merged]);
    expect(first.toolCalls).toEqual([{ name: "curl", arguments: { url: "http://a" } }]);
    expect(second.toolCalls.map((tc) => tc.name)).toEqual(["a", "b"]);
  });

  it("counts tool calls cumulatively across the transcript", () => {
    const items = annotateTranscriptSteps([
      step("user"),
      step("tool_call", "", { toolCall: { name: "a", arguments: {} } }),
      step("tool_result"),
      step("tool_call", "", { toolCall: { name: "b", arguments: {} } }),
      step("assistant"),
    ]);
    expect(items.map((item) => item.cumulativeToolCalls)).toEqual([0, 1, 1, 2, 2]);
    expect(items.map((item) => item.toolCalls.length)).toEqual([0, 1, 0, 1, 0]);
  });

  it("keeps each item's step identity", () => {
    const steps = [step("user"), step("assistant")];
    expect(annotateTranscriptSteps(steps).map((item) => item.step)).toEqual(steps);
  });
});
