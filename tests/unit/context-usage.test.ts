import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyContextPlacement, buildContextUsageNote, contextPercent, type PlacementStep } from "../../shared/context-usage";

describe("contextPercent", () => {
  it("rounds to the nearest integer percentage", () => {
    expect(contextPercent(6120, 8192)).toBe(75);
    expect(contextPercent(1, 3)).toBe(33);
    expect(contextPercent(2, 3)).toBe(67);
    expect(contextPercent(0, 8192)).toBe(0);
  });

  it("may exceed 100 when more tokens are used than the window holds", () => {
    expect(contextPercent(9000, 8192)).toBe(110);
  });

  it.each([0, -1, Number.NaN])("is 0 for a non-positive window %j instead of NaN/Infinity", (window) => {
    expect(contextPercent(100, window)).toBe(0);
  });

  it("is monotonic in used tokens for a fixed window (property)", () => {
    fc.assert(
      fc.property(fc.nat(500_000), fc.nat(500_000), fc.integer({ min: 1, max: 500_000 }), (a, b, window) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(contextPercent(low, window)).toBeLessThanOrEqual(contextPercent(high, window));
        expect(Number.isInteger(contextPercent(low, window))).toBe(true);
      }),
      { seed: 20261002 }
    );
  });
});

describe("applyContextPlacement / buildContextUsageNote edge contracts (mutation audit)", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const s = (id: string, kind: string, content: string, extra: Record<string, unknown> = {}) =>
    ({ id, kind, title: kind, content, createdAt: at, ...extra }) as PlacementStep;
  const shape = (steps: PlacementStep[]) => steps.map((step) => `${step.kind}:${step.content}`);

  it("collates only a following user (or compaction) step onto the summary, never an assistant step", () => {
    expect(shape(applyContextPlacement([s("c", "compaction", "S"), s("a", "assistant", "A")]))).toEqual(["user:S", "assistant:A"]);
    expect(shape(applyContextPlacement([s("c", "compaction", "S"), s("u", "user", "U")]))).toEqual(["user:S\n\nU"]);
  });

  it("a non-empty system step between summary and user keeps them apart; an empty one is not a wire step", () => {
    expect(shape(applyContextPlacement([s("c", "compaction", "S"), s("y", "system", "rules"), s("u", "user", "U")])))
      .toEqual(["user:S", "system:rules", "user:U"]);
    expect(shape(applyContextPlacement([s("c", "compaction", "S"), s("y", "system", "  "), s("u", "user", "U")])))
      .toEqual(["user:S\n\nU", "system:  "]);
  });

  it("a trailing tool_call with its payload is a wire step, so the note becomes its own user step", () => {
    const call = s("t", "tool_call", "", { toolCall: { id: "k", name: "web_search", arguments: {} } });
    const placed = applyContextPlacement([s("u", "user", "U"), call], { note: "NOTE" });
    expect(shape(placed)).toEqual(["user:U", "tool_call:", "user:NOTE"]);
  });

  it("the note replaces a whitespace-only last user message instead of being appended to blanks", () => {
    expect(shape(applyContextPlacement([s("u", "user", " \n ")], { note: "NOTE" }))).toEqual(["user:NOTE"]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("an unusable used-token count %j yields the number-free note", (usedTokens) => {
    const note = buildContextUsageNote({ usedTokens, windowTokens: 8192, source: "runtime" });
    expect(note).toBe(buildContextUsageNote({ windowTokens: 8192, source: "runtime" }));
    expect(note).not.toMatch(/\d|%/);
  });
});
