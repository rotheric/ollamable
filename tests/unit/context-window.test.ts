import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ConversationStep, OllamaModelMeta } from "@/src/types/chat";
import {
  ASSUMED_CONTEXT_WINDOW,
  computeContextFill,
  recordRuntimeWindow,
  rememberedWindow,
  resolveContextWindow,
} from "@/src/lib/context-window";
import { modelIdentity } from "@/src/lib/model-identity";

function meta(overrides: Partial<OllamaModelMeta> = {}): OllamaModelMeta {
  return {
    name: "qwen3:1.7b",
    parameters: "temperature 0.6\nnum_ctx                        4096\nstop \"<|im_end|>\"",
    modelInfo: { "general.architecture": "qwen3", "qwen3.context_length": 40960 },
    ...overrides,
  };
}

function step(kind: ConversationStep["kind"], usage?: ConversationStep["usage"]): ConversationStep {
  return { id: `${kind}-${Math.random()}`, kind, title: kind, content: "", createdAt: "2026-01-01T00:00:00.000Z", usage };
}

describe("resolveContextWindow", () => {
  it("AC-CTX-1: a loaded model's runtime window wins over everything, without a stale flag", () => {
    const resolved = resolveContextWindow({
      runtime: { loaded: true, contextLength: 32768 },
      remembered: 2048,
      modelMeta: meta(),
    });
    expect(resolved).toEqual({ tokens: 32768, source: "runtime" });
    expect("stale" in resolved).toBe(false);
  });

  it("AC-CTX-2: an unloaded model with a remembered window resolves it as stale runtime, ignoring the Modelfile", () => {
    expect(resolveContextWindow({ runtime: { loaded: false }, remembered: 16384, modelMeta: meta() })).toEqual({
      tokens: 16384,
      source: "runtime",
      stale: true,
    });
  });

  it("AC-CTX-2: a failed runtime query (undefined) still falls back to the remembered window", () => {
    expect(resolveContextWindow({ remembered: 16384 })).toEqual({ tokens: 16384, source: "runtime", stale: true });
  });

  it("AC-CTX-3: with nothing remembered, a Modelfile num_ctx line gives source modelfile", () => {
    expect(resolveContextWindow({ runtime: { loaded: false }, modelMeta: meta() })).toEqual({
      tokens: 4096,
      source: "modelfile",
    });
  });

  it("AC-CTX-3: without a num_ctx line the architecture maximum is estimated", () => {
    expect(resolveContextWindow({ runtime: { loaded: false }, modelMeta: meta({ parameters: "temperature 0.6" }) })).toEqual({
      tokens: 40960,
      source: "estimated",
    });
  });

  it("AC-CTX-3: the estimate falls back to any *.context_length key when general.architecture is absent", () => {
    expect(resolveContextWindow({ modelMeta: meta({ parameters: undefined, modelInfo: { "llama.context_length": 131072 } }) })).toEqual({
      tokens: 131072,
      source: "estimated",
    });
  });

  it("the estimate prefers the declared architecture's context_length over any other *.context_length key", () => {
    const modelInfo = { "clip.context_length": 2048, "general.architecture": "llama", "llama.context_length": 131072 };
    expect(resolveContextWindow({ modelMeta: meta({ parameters: undefined, modelInfo }) })).toEqual({ tokens: 131072, source: "estimated" });
  });

  it("the estimate falls back to another *.context_length key when the declared architecture has none", () => {
    const modelInfo = { "general.architecture": "llama", "llama.context_length": 0, "clip.context_length": 2048 };
    expect(resolveContextWindow({ modelMeta: meta({ parameters: undefined, modelInfo }) })).toEqual({ tokens: 2048, source: "estimated" });
  });

  it("the estimate never takes a number from a key that is not a *.context_length", () => {
    const modelInfo = { "general.parameter_count": 7, "general.file_type": 2, "llama.block_count": 32, "llama.context_length": 4096 };
    expect(resolveContextWindow({ modelMeta: meta({ parameters: undefined, modelInfo }) })).toEqual({ tokens: 4096, source: "estimated" });
  });

  it("AC-CTX-4: undefined modelMeta (skipped or failed /models/show) is the 8192 assumption", () => {
    expect(resolveContextWindow({ runtime: { loaded: false } })).toEqual({ tokens: 8192, source: "assumed" });
    expect(ASSUMED_CONTEXT_WINDOW).toBe(8192);
  });

  it("AC-CTX-4: metadata without any context_length key is also assumed", () => {
    expect(resolveContextWindow({ modelMeta: meta({ parameters: undefined, modelInfo: { "general.architecture": "qwen3" } }) })).toEqual({
      tokens: 8192,
      source: "assumed",
    });
  });

  it.each(["num_ctx 0", "num_ctx abc", "num_ctx -5", "# num_ctx 4096", "my_num_ctx 4096", "num_ctx 40.5"])(
    "ignores a malformed or non-line Modelfile value %j",
    (parameters) => {
      expect(resolveContextWindow({ modelMeta: meta({ parameters, modelInfo: undefined }) })).toEqual({ tokens: 8192, source: "assumed" });
    }
  );

  it.each([
    { loaded: true },
    { loaded: true, contextLength: 0 },
    { loaded: true, contextLength: 1.5 },
    { loaded: false, contextLength: 4096 },
  ])("does not treat the runtime report %j as a live window", (runtime) => {
    expect(resolveContextWindow({ runtime }).source).toBe("assumed");
  });

  it.each([0, -1, 2.5, Number.NaN])("ignores an invalid remembered window %j", (remembered) => {
    expect(resolveContextWindow({ remembered }).source).toBe("assumed");
  });

  it("returns a positive integer token count with a source from the four-value set, and stale only with runtime (property)", () => {
    const maybeInt = fc.option(fc.integer({ min: -10, max: 200_000 }), { nil: undefined });
    fc.assert(
      fc.property(
        fc.option(fc.record({ loaded: fc.boolean(), contextLength: maybeInt }), { nil: undefined }),
        maybeInt,
        fc.option(
          fc.record({
            name: fc.constant("m"),
            parameters: fc.option(fc.string(), { nil: undefined }),
            modelInfo: fc.option(fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string())), { nil: undefined }),
          }),
          { nil: undefined }
        ),
        (runtime, remembered, modelMeta) => {
          const resolved = resolveContextWindow({ runtime, remembered, modelMeta });
          expect(Number.isInteger(resolved.tokens) && resolved.tokens > 0).toBe(true);
          expect(["runtime", "modelfile", "estimated", "assumed"]).toContain(resolved.source);
          if (resolved.stale !== undefined) {
            expect(resolved.stale).toBe(true);
            expect(resolved.source).toBe("runtime");
          }
        }
      ),
      { seed: 20261002 }
    );
  });
});

describe("recordRuntimeWindow / rememberedWindow", () => {
  it("AC-CTX-1: a live runtime window is remembered under the provider/model identity", () => {
    const next = recordRuntimeWindow({}, "ollama", "qwen3:1.7b", { tokens: 4096, source: "runtime" });
    expect(next).toEqual({ [modelIdentity("ollama", "qwen3:1.7b")]: 4096 });
    expect(rememberedWindow(next, "ollama", "qwen3:1.7b")).toBe(4096);
    expect(rememberedWindow(next, "other", "qwen3:1.7b")).toBeUndefined();
  });

  it("treats untagged and :latest Ollama names, and provider undefined, as one remembered entry", () => {
    const next = recordRuntimeWindow({}, "ollama", "llama3", { tokens: 4096, source: "runtime" });
    expect(rememberedWindow(next, "ollama", "llama3:latest")).toBe(4096);
    expect(rememberedWindow(next, "ollama", "llama3")).toBe(4096);
    const other = recordRuntimeWindow({}, "ollama", "llama3:latest", { tokens: 2048, source: "runtime" });
    expect(rememberedWindow(other, "ollama", "llama3")).toBe(2048);
    expect(recordRuntimeWindow(next, "ollama", "llama3:latest", { tokens: 4096, source: "runtime" })).toBe(next);
    const noProvider = recordRuntimeWindow({}, undefined, "m", { tokens: 100, source: "runtime" });
    expect(rememberedWindow(noProvider, undefined, "m:latest")).toBe(100);
    expect(rememberedWindow(noProvider, "ollama", "m")).toBeUndefined();
  });

  it("replaces a changed window and keeps other models", () => {
    const first = recordRuntimeWindow({}, "p", "a", { tokens: 1000, source: "runtime" });
    const second = recordRuntimeWindow(first, "p", "b", { tokens: 2000, source: "runtime" });
    const third = recordRuntimeWindow(second, "p", "a", { tokens: 3000, source: "runtime" });
    expect(rememberedWindow(third, "p", "a")).toBe(3000);
    expect(rememberedWindow(third, "p", "b")).toBe(2000);
  });

  it("returns the same record when nothing changes", () => {
    const remembered = { [modelIdentity("p", "a:latest")]: 1000 };
    expect(recordRuntimeWindow(remembered, "p", "a", { tokens: 1000, source: "runtime" })).toBe(remembered);
  });

  it.each([
    { tokens: 4096, source: "runtime" as const, stale: true },
    { tokens: 4096, source: "modelfile" as const },
    { tokens: 4096, source: "estimated" as const },
    { tokens: 8192, source: "assumed" as const },
  ])("never remembers a window that is not live: %j", (resolved) => {
    const remembered = {};
    expect(recordRuntimeWindow(remembered, "p", "a", resolved)).toBe(remembered);
  });
});

describe("computeContextFill", () => {
  const window = { tokens: 8192 };

  it("AC-CTX-8: an assistant step with no usage anywhere is unknown", () => {
    expect(computeContextFill([step("user"), step("assistant")], window)).toEqual({ unknown: true });
  });

  it("AC-CTX-8: a stopReason-only usage (provider reported no token counts) is still unknown", () => {
    expect(computeContextFill([step("user"), step("assistant", { stopReason: "stop" })], window)).toEqual({ unknown: true });
  });

  it("AC-CTX-8: a tool-only latest response with stopReason-only usage is unknown, not an older figure", () => {
    const steps = [
      step("user"),
      step("assistant", { inputTokens: 1000, outputTokens: 50 }),
      step("user"),
      step("tool_call", { stopReason: "tool_calls" }),
      step("tool_result"),
    ];
    expect(computeContextFill(steps, window)).toEqual({ unknown: true });
  });

  it("AC-CTX-8: a tool-only response without a usable usage is unknown, with or without a trailing user step", () => {
    const stopOnly = { stopReason: "tool_calls" };
    expect(computeContextFill([step("system"), step("user"), step("tool_call", stopOnly), step("tool_result")], window)).toEqual({ unknown: true });
    expect(computeContextFill([step("system"), step("user"), step("tool_call", stopOnly), step("tool_result"), step("user")], window)).toEqual({ unknown: true });
    expect(computeContextFill([step("system"), step("user"), step("tool_call"), step("tool_result")], window)).toEqual({ unknown: true });
    // A completed response that reported nothing carries an empty usage object (server contract).
    const earlier = [step("user"), step("assistant", { inputTokens: 1000, outputTokens: 50 }), step("user")];
    expect(computeContextFill([...earlier, step("tool_call", {}), step("tool_result")], window)).toEqual({ unknown: true });
  });

  it("none-yet: histories with no model response are zero fill; a latest numeric usage is numeric", () => {
    expect(computeContextFill([step("system"), step("user")], window)).toEqual({ usedTokens: 0, percent: 0, level: "ok" });
    expect(computeContextFill([step("system")], window)).toEqual({ usedTokens: 0, percent: 0, level: "ok" });
    expect(computeContextFill([step("user"), step("tool_call", { inputTokens: 4096, outputTokens: 0 })], window))
      .toEqual({ usedTokens: 4096, percent: 50, level: "ok" });
  });

  it("none-yet: no usage and no assistant response is zero fill", () => {
    expect(computeContextFill([], window)).toEqual({ usedTokens: 0, percent: 0, level: "ok" });
    expect(computeContextFill([step("system"), step("user")], window)).toEqual({ usedTokens: 0, percent: 0, level: "ok" });
  });

  it("known: uses inputTokens + outputTokens of the most recent step carrying usage, of any kind", () => {
    const steps = [
      step("user"),
      step("assistant", { inputTokens: 100, outputTokens: 20 }),
      step("tool_result"),
      step("tool_call", { inputTokens: 6000, outputTokens: 120 }),
      step("tool_result"),
    ];
    expect(computeContextFill(steps, window)).toEqual({ usedTokens: 6120, percent: 75, level: "ok" });
  });

  it("AC-CTX-8: a latest assistant response without usage is unknown even when an older one reported usage", () => {
    const steps = [step("user"), step("assistant", { inputTokens: 100, outputTokens: 20 }), step("user"), step("assistant")];
    expect(computeContextFill(steps, window)).toEqual({ unknown: true });
    expect(computeContextFill([...steps, step("tool_result")], window)).toEqual({ unknown: true });
  });

  it("holds the previous completed value while a response streams (in-flight steps are ignored)", () => {
    const streaming = (kind: ConversationStep["kind"], usage?: ConversationStep["usage"]) => ({ ...step(kind, usage), id: `stream-${kind}` });
    const steps = [step("user"), step("assistant", { inputTokens: 100, outputTokens: 20 }), step("user"), streaming("assistant")];
    expect(computeContextFill(steps, window)).toMatchObject({ usedTokens: 120 });
    // Not even streamed usage replaces it until the response is stable.
    expect(computeContextFill([...steps, streaming("assistant", { inputTokens: 900 })], window)).toMatchObject({ usedTokens: 120 });
    // First response of a conversation: still the none-yet zero fill, not "unknown".
    expect(computeContextFill([step("user"), streaming("assistant")], window)).toEqual({ usedTokens: 0, percent: 0, level: "ok" });
  });

  it("treats a missing token field as zero", () => {
    expect(computeContextFill([step("assistant", { inputTokens: 819 })], window)).toMatchObject({ usedTokens: 819, percent: 10 });
  });

  // Bands use the raw ratio (error at >= 100%, warn from 80%); the percent is display-only.
  it.each([
    [6000, 73, "ok"],
    [6512, 79, "ok"],
    [6553, 80, "ok"],
    [6554, 80, "warn"],
    [8151, 99, "warn"],
    [8152, 100, "warn"],
    [8192, 100, "error"],
    [9000, 110, "error"],
  ])("level bands: %i of 8192 tokens is %i%% (%s)", (used, percent, level) => {
    expect(computeContextFill([step("assistant", { inputTokens: used })], window)).toEqual({ usedTokens: used, percent, level });
  });

  it.each([
    [799, "ok"],
    [800, "warn"],
    [999, "warn"],
    [1000, "error"],
  ])("level boundaries on a 1000-token window: %i tokens is %s (79.9 ok, 80 warn, 99.9 warn, 100 error)", (used, level) => {
    expect(computeContextFill([step("assistant", { inputTokens: used })], { tokens: 1000 })).toMatchObject({ level });
  });

  it("99.5% displays as 100 but stays warn", () => {
    expect(computeContextFill([step("assistant", { inputTokens: 995 })], { tokens: 1000 })).toEqual({ usedTokens: 995, percent: 100, level: "warn" });
  });

  it("is the latest response's usage; unknown when the latest response reports none (property)", () => {
    const stepArb = fc.record({
      kind: fc.constantFrom<ConversationStep["kind"]>("system", "user", "assistant", "reasoning", "tool_call", "tool_result", "meta"),
      usage: fc.option(
        fc.record({
          inputTokens: fc.option(fc.nat(100_000), { nil: undefined }),
          outputTokens: fc.option(fc.nat(100_000), { nil: undefined }),
          stopReason: fc.option(fc.constant("stop"), { nil: undefined }),
        }),
        { nil: undefined }
      ),
    });
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 12 }), fc.integer({ min: 1, max: 200_000 }), (steps, tokens) => {
        const fill = computeContextFill(steps, { tokens });
        const hasTokens = (s: (typeof steps)[number]) => !!s.usage && (s.usage.inputTokens !== undefined || s.usage.outputTokens !== undefined);
        // The latest response decides: its own token usage, or unknown when it reported none.
        const latest = [...steps].reverse().find((s) => hasTokens(s) || s.kind === "assistant" || !!s.usage);
        if (latest && hasTokens(latest)) {
          const last = latest.usage!;
          expect(fill).toMatchObject({ usedTokens: (last.inputTokens ?? 0) + (last.outputTokens ?? 0) });
        } else if (latest || steps.some((s) => s.kind === "tool_call")) {
          expect(fill).toEqual({ unknown: true });
        } else {
          expect(fill).toEqual({ usedTokens: 0, percent: 0, level: "ok" });
        }
      }),
      { seed: 20261002 }
    );
  });
});
