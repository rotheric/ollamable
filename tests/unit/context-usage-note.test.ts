import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  CONTEXT_PLACEMENT,
  COMPACT_CONTEXT_TOOL_NAME,
  applyContextPlacement,
  buildContextUsageNote,
  contextPercent,
  isCompactContextEnabled,
  lastUsedTokens,
  placeStepsForModel,
  type ContextNoteSource,
  type ContextPlacement,
  type PlacementStep,
} from "../../shared/context-usage";

function step(kind: string, content: string, extra: Partial<PlacementStep> & Record<string, unknown> = {}): PlacementStep {
  return { id: `${kind}-${content}`, kind, title: kind, content, createdAt: "2026-01-01T00:00:00.000Z", ...extra };
}

const SOURCES: ContextNoteSource[] = ["runtime", "modelfile", "estimated", "assumed"];

describe("buildContextUsageNote", () => {
  it("AC-NOTE-1: states used tokens, window, percentage and the tool name for a runtime window", () => {
    const note = buildContextUsageNote({ usedTokens: 6120, windowTokens: 8192, source: "runtime" });
    expect(note).toContain("6,120");
    expect(note).toContain("8,192");
    expect(note).toContain(`${contextPercent(6120, 8192)}%`);
    expect(note).toContain("75%");
    expect(note).toContain("compact_context");
    expect(COMPACT_CONTEXT_TOOL_NAME).toBe("compact_context");
  });

  it("AC-NOTE-1: a modelfile window reads like a runtime window", () => {
    const note = buildContextUsageNote({ usedTokens: 6120, windowTokens: 8192, source: "modelfile" });
    expect(note).toContain("6,120 of 8,192 tokens (75%)");
  });

  it("AC-NOTE-1: is independent of the process locale", async () => {
    // Make the host's default locale German: a formatter built without an explicit locale would group with ".".
    const RealNumberFormat = Intl.NumberFormat;
    const GermanDefault = function (locales?: string | string[], options?: Intl.NumberFormatOptions) {
      return new RealNumberFormat(locales ?? "de-DE", options);
    } as unknown as typeof Intl.NumberFormat;
    expect(new GermanDefault().format(6120)).toBe("6.120");
    vi.resetModules();
    vi.stubGlobal("Intl", { ...Intl, NumberFormat: GermanDefault });
    try {
      const fresh = await import("../../shared/context-usage");
      const note = fresh.buildContextUsageNote({ usedTokens: 6120, windowTokens: 8192, source: "runtime" });
      expect(note).toContain("6,120");
      expect(note).toContain("8,192");
      expect(note).not.toContain("6.120");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it.each(SOURCES)("AC-NOTE-2: without usedTokens (%s) the note names the tool and has no digit and no %%", (source) => {
    const note = buildContextUsageNote({ windowTokens: 8192, source });
    expect(note).toContain("compact_context");
    expect(note).not.toMatch(/\d/);
    expect(note).not.toContain("%");
  });

  it("AC-NOTE-7: an assumed window states the used tokens but neither the window nor a percentage", () => {
    const note = buildContextUsageNote({ usedTokens: 6120, windowTokens: 8192, source: "assumed" });
    expect(note).toContain("6,120");
    expect(note).not.toContain("8,192");
    expect(note).not.toContain("8192");
    expect(note).not.toContain("%");
    expect(note).toContain("compact_context");
  });

  it("AC-NOTE-7: an estimated window is marked approximate", () => {
    const note = buildContextUsageNote({ usedTokens: 6120, windowTokens: 8192, source: "estimated" });
    expect(note).toContain("approximately");
    expect(note).toContain("8,192");
    expect(note).toContain("75%");
    expect(buildContextUsageNote({ usedTokens: 6120, windowTokens: 8192, source: "runtime" })).not.toContain("approximately");
  });

  it("embeds exactly the number contextPercent computes, with no second rounding (property)", () => {
    fc.assert(
      fc.property(fc.nat(2_000_000), fc.integer({ min: 1, max: 2_000_000 }), (used, window) => {
        const note = buildContextUsageNote({ usedTokens: used, windowTokens: window, source: "runtime" });
        expect(note).toContain(`(${contextPercent(used, window)}%)`);
        expect(note).toContain(used.toLocaleString("en-US"));
        expect(note).toContain(window.toLocaleString("en-US"));
      }),
      { seed: 20261002 }
    );
  });

  it("is robust at boundaries: zero used, used above window, zero window, non-finite numbers", () => {
    expect(buildContextUsageNote({ usedTokens: 0, windowTokens: 8192, source: "runtime" })).toContain("0 of 8,192 tokens (0%)");
    expect(buildContextUsageNote({ usedTokens: 9000, windowTokens: 8192, source: "runtime" })).toContain("(110%)");
    for (const note of [
      buildContextUsageNote({ usedTokens: 500, windowTokens: 0, source: "runtime" }),
      buildContextUsageNote({ usedTokens: 500, windowTokens: Number.NaN, source: "estimated" }),
      buildContextUsageNote({ usedTokens: Number.NaN, windowTokens: 8192, source: "runtime" }),
      buildContextUsageNote({ usedTokens: Number.POSITIVE_INFINITY, windowTokens: 8192, source: "runtime" }),
      buildContextUsageNote({ usedTokens: -5, windowTokens: 8192, source: "runtime" }),
    ]) {
      expect(note).not.toMatch(/NaN|Infinity|-\d/);
      expect(note).toContain("compact_context");
    }
    // No window to compare against: used tokens only, never a percentage.
    expect(buildContextUsageNote({ usedTokens: 500, windowTokens: 0, source: "runtime" })).not.toContain("%");
  });

  it("never contains a number the app does not know (property over every input shape)", () => {
    fc.assert(
      fc.property(
        fc.option(fc.double({ noNaN: false }), { nil: undefined }),
        fc.double({ noNaN: false }),
        fc.constantFrom(...SOURCES),
        (usedTokens, windowTokens, source) => {
          const note = buildContextUsageNote({ usedTokens, windowTokens, source });
          expect(note).not.toMatch(/NaN|Infinity|undefined/);
          if (usedTokens === undefined) expect(note).not.toMatch(/\d/);
        }
      ),
      { seed: 20261002 }
    );
  });
});

describe("lastUsedTokens", () => {
  it("sums input and output tokens of the last step of any kind carrying usage", () => {
    const steps = [
      step("assistant", "a", { usage: { inputTokens: 10, outputTokens: 5 } }),
      step("meta", "Model usage", { usage: { inputTokens: 100, outputTokens: 20 } }),
      step("tool_result", "r"),
    ];
    expect(lastUsedTokens(steps)).toBe(120);
  });

  it("counts a missing half as zero and is undefined when nothing reports usage", () => {
    expect(lastUsedTokens([step("assistant", "a", { usage: { inputTokens: 7 } })])).toBe(7);
    expect(lastUsedTokens([step("assistant", "a", { usage: {} })])).toBeUndefined();
    expect(lastUsedTokens([])).toBeUndefined();
  });

  it("AC-NOTE-5: a latest assistant step without usage is undefined even when an older response reported usage", () => {
    const withUsage = step("assistant", "a1", { usage: { inputTokens: 10, outputTokens: 5 } });
    expect(lastUsedTokens([withUsage, step("user", "u"), step("assistant", "a2")])).toBeUndefined();
    expect(lastUsedTokens([withUsage, step("user", "u"), step("assistant", "a2"), step("tool_result", "r")])).toBeUndefined();
    // Usage-less steps of other kinds are skipped.
    expect(lastUsedTokens([withUsage, step("user", "u"), step("tool_result", "r"), step("reasoning", "t")])).toBe(15);
  });
});

describe("applyContextPlacement", () => {
  const conversation = (): PlacementStep[] => [
    step("system", "be terse"),
    step("user", "hello"),
    step("assistant", "hi"),
    step("user", "what is 2+2?"),
  ];

  it("returns the steps unchanged (as a new array) when there is no note and nothing to map", () => {
    const input = conversation();
    const out = applyContextPlacement(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it("collates the note onto a last user step as a blank-line separated paragraph", () => {
    const out = applyContextPlacement(conversation(), { note: "NOTE" });
    expect(out).toHaveLength(4);
    expect(out[3].kind).toBe("user");
    expect(out[3].content).toBe("what is 2+2?\n\nNOTE");
  });

  it("adds a separate user step after an assistant or tool result", () => {
    const afterTool = [step("user", "q"), step("assistant", "", { toolCalls: [{ name: "t", arguments: {} }] }), step("tool_result", "r", { toolResult: { name: "t" } })];
    const out = applyContextPlacement(afterTool, { note: "NOTE" });
    expect(out).toHaveLength(4);
    expect(out[3]).toMatchObject({ kind: "user", content: "NOTE" });
    const afterAssistant = applyContextPlacement([step("user", "q"), step("assistant", "a")], { note: "NOTE" });
    expect(afterAssistant.map((s) => s.kind)).toEqual(["user", "assistant", "user"]);
  });

  it("looks past trailing meta, reasoning and empty system steps when choosing the step to collate onto", () => {
    const input = [step("user", "q"), step("meta", "m"), step("reasoning", "r"), step("system", "  ")];
    const out = applyContextPlacement(input, { note: "NOTE" });
    expect(out).toHaveLength(4);
    expect(out[0].content).toBe("q\n\nNOTE");
  });

  it("uses the note alone when the user step it collates onto is blank", () => {
    expect(applyContextPlacement([step("user", "")], { note: "NOTE" })[0].content).toBe("NOTE");
  });

  it("places the note into a conversation with no steps", () => {
    expect(applyContextPlacement([], { note: "NOTE" })).toMatchObject([{ kind: "user", content: "NOTE" }]);
  });

  it("AC-NOTE-9: never mutates its input (deep-equal before and after, and nothing shared is edited)", () => {
    const input = [step("system", "s"), step("compaction", "summary"), step("user", "q")];
    const before = structuredClone(input);
    const refs = [...input];
    const out = applyContextPlacement(input, { note: "NOTE" });
    expect(input).toEqual(before);
    input.forEach((s, i) => expect(s).toBe(refs[i]));
    expect(out).not.toBe(input);
  });

  it("maps a compaction step to a user-role step and collates the user's next message onto it", () => {
    const input = [step("system", "s"), step("compaction", "SUMMARY"), step("user", "continue please")];
    const out = applyContextPlacement(input);
    expect(out.map((s) => s.kind)).toEqual(["system", "user"]);
    expect(out[1].content).toBe("SUMMARY\n\ncontinue please");
  });

  it("keeps a lone compaction step as one user step (the fork's first request) and takes the note on it", () => {
    const input = [step("system", "s"), step("compaction", "SUMMARY")];
    expect(applyContextPlacement(input).map((s) => [s.kind, s.content])).toEqual([["system", "s"], ["user", "SUMMARY"]]);
    expect(applyContextPlacement(input, { note: "NOTE" })[1].content).toBe("SUMMARY\n\nNOTE");
  });

  it("leaves ordinary adjacent user steps alone (only compaction collates)", () => {
    const out = applyContextPlacement([step("user", "a"), step("user", "b")]);
    expect(out.map((s) => s.content)).toEqual(["a", "b"]);
  });

  it("looks up family exceptions by family and uses the default otherwise", () => {
    const placement: ContextPlacement = { ...CONTEXT_PLACEMENT, exceptions: { odd: { note: "trailing-system" } } };
    const input = conversation();
    expect(() => applyContextPlacement(input, { note: "N", family: "odd", placement })).toThrow(/Unsupported note placement/);
    for (const family of [undefined, "qwen3", "llama"]) {
      expect(applyContextPlacement(input, { note: "N", family, placement })[3].content).toBe("what is 2+2?\n\nN");
    }
    const summaryOdd: ContextPlacement = { ...CONTEXT_PLACEMENT, exceptions: { odd: { summary: "system" } } };
    expect(() => applyContextPlacement(input, { family: "odd", placement: summaryOdd })).toThrow(/Unsupported summary placement/);
  });

  it("yields the same positions for every family in the placement data and for an absent family", () => {
    const families = [undefined, ...Object.keys(CONTEXT_PLACEMENT.exceptions)];
    const expected = applyContextPlacement(conversation(), { note: "N" });
    for (const family of families) expect(applyContextPlacement(conversation(), { note: "N", family })).toEqual(expected);
  });

  it("preserves every non-note step in order and adds the note exactly once (property)", () => {
    const kind = fc.constantFrom("system", "user", "assistant", "tool_result", "meta", "reasoning");
    fc.assert(
      fc.property(
        fc.array(fc.record({ kind, content: fc.string({ maxLength: 8 }) }), { maxLength: 8 }),
        fc.boolean(),
        (specs, withNote) => {
          const input = specs.map((spec, i) => step(spec.kind, spec.content, { id: `s${i}` }));
          const before = structuredClone(input);
          const out = applyContextPlacement(input, withNote ? { note: "§NOTE§" } : {});
          expect(input).toEqual(before);
          expect(out.map((s) => s.id).filter((id) => id !== "context-usage-note")).toEqual(input.map((s) => s.id));
          const occurrences = out.filter((s) => s.content.includes("§NOTE§")).length;
          expect(occurrences).toBe(withNote ? 1 : 0);
          // The note never creates two adjacent user messages on its own.
          const wire = out.filter((s) => s.kind !== "meta" && s.kind !== "reasoning" && !(s.kind === "system" && !s.content.trim()));
          const originalWire = input.filter((s) => s.kind !== "meta" && s.kind !== "reasoning" && !(s.kind === "system" && !s.content.trim()));
          const adjacentUsers = (list: PlacementStep[]) => list.filter((s, i) => i > 0 && s.kind === "user" && list[i - 1].kind === "user").length;
          expect(adjacentUsers(wire)).toBeLessThanOrEqual(adjacentUsers(originalWire));
        }
      ),
      { seed: 20261002 }
    );
  });
});

describe("placeStepsForModel", () => {
  const steps = [step("user", "q", {}), step("assistant", "a", { usage: { inputTokens: 6000, outputTokens: 120 } }), step("user", "next")];

  it("adds no note while compact_context is not enabled", () => {
    const out = placeStepsForModel(steps, { compactEnabled: false, usedTokens: 6120, window: { tokens: 8192, source: "runtime" } });
    expect(out.map((s) => s.content)).toEqual(["q", "a", "next"]);
  });

  it("builds the note from the given used tokens and window", () => {
    const out = placeStepsForModel(steps, { compactEnabled: true, usedTokens: 6120, window: { tokens: 8192, source: "runtime" } });
    expect(out[2].content).toBe(`next\n\n${buildContextUsageNote({ usedTokens: 6120, windowTokens: 8192, source: "runtime" })}`);
  });

  it("treats a missing window as assumed (used tokens only) and missing usage as number-free", () => {
    const assumed = placeStepsForModel(steps, { compactEnabled: true, usedTokens: 6120 });
    expect(assumed[2].content).toContain("6,120");
    expect(assumed[2].content).not.toContain("%");
    const none = placeStepsForModel(steps, { compactEnabled: true, usedTokens: undefined, window: { tokens: 8192, source: "runtime" } });
    expect(none[2].content).not.toMatch(/\d/);
  });
});

describe("isCompactContextEnabled", () => {
  it("is true only when compact_context is among the tools", () => {
    expect(isCompactContextEnabled([{ name: "x" }, { name: "compact_context" }])).toBe(true);
    expect(isCompactContextEnabled([{ name: "x" }])).toBe(false);
    expect(isCompactContextEnabled([])).toBe(false);
    expect(isCompactContextEnabled(undefined)).toBe(false);
  });
});

describe("applyContextPlacement wire-step predicate mirrors the formatters", () => {
  it("collates the note onto the user step when a payload-less tool_result follows it", () => {
    const out = applyContextPlacement([step("user", "q"), step("tool_result", "orphan")], { note: "NOTE" });
    expect(out.map((s) => s.kind)).toEqual(["user", "tool_result"]);
    expect(out[0].content).toBe("q\n\nNOTE");
  });

  it("collates the note onto the user step when a payload-less tool_call follows it", () => {
    const out = applyContextPlacement([step("user", "q"), step("tool_call", "orphan")], { note: "NOTE" });
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe("q\n\nNOTE");
  });

  it("still adds a separate user step after a tool_result that has its payload", () => {
    const out = applyContextPlacement([step("user", "q"), step("tool_result", "r", { toolResult: { name: "t" } })], { note: "NOTE" });
    expect(out.map((s) => s.kind)).toEqual(["user", "tool_result", "user"]);
  });
});
