/**
 * Unit tests for src/lib/token-view.ts — the module owning separator
 * formatting, whitespace markers, and boundary-source resolution for the
 * `showTokens` display mode (epic-token-view story S2).
 *
 * Covers AC-UX-2, AC-UX-4, AC-UX-8, AC-ERR-1, and AC-STRUCT-3's
 * formatting/resolution-placement requirement. The `computed` and
 * `pending` boundary sources are exercised here exclusively via an
 * injected fake (MOCK-02-001) per AC-UX-2's explicit no-S3 clause and
 * story S2's scope — production chat-workspace.tsx wiring passes no
 * computedSource until S3 lands.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, renderHook, act } from "@testing-library/react";
import type { ConversationStep } from "@/src/types/chat";
import {
  SEPARATOR,
  NEWLINE_MARKER,
  SPACE_RUN_MARKER,
  STREAM_LABEL,
  STREAM_CAVEAT,
  COMPUTED_LABEL,
  COMPUTED_NOTICE,
  UNAVAILABLE_REASON,
  COMPUTED_MISMATCH_REASON,
  resolveBoundarySource,
  useTokenBoundaries,
  formatTokenViewText,
  getBoundaryNotice,
  type TokenBoundaryResult,
} from "@/src/lib/token-view";

function makeStep(overrides: Partial<ConversationStep> = {}): ConversationStep {
  return {
    id: "step-1",
    kind: "assistant",
    title: "Assistant",
    content: "Hello world",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("formatTokenViewText", () => {
  it("inserts SEPARATOR at token boundaries, not within a token", () => {
    const out = formatTokenViewText("Hello world", ["Hello", " world"]);
    expect(out).toBe(`Hello${SEPARATOR} world`);
  });

  it("does not render one element per token — callers get a single string", () => {
    const out = formatTokenViewText("a b c", ["a", " b", " c"]);
    expect(typeof out).toBe("string");
    expect(out).toBe(`a${SEPARATOR} b${SEPARATOR} c`);
  });

  it("keeps a literal '|' in content distinguishable from the SEPARATOR", () => {
    // Token boundary falls between "price: " and "$5 | $10" — the pipe
    // itself sits inside a single token, nowhere near a boundary.
    const content = "price: $5 | $10";
    const out = formatTokenViewText(content, ["price: ", "$5 | $10"]);
    expect(out).toBe(`price: ${SEPARATOR}$5 | $10`);
    // Exactly one SEPARATOR (the real boundary); the literal pipe survives as ASCII.
    expect(out.split(SEPARATOR)).toHaveLength(2);
    expect(out).toContain("$5 | $10");
    expect(out.includes("$5 │ $10")).toBe(false);
  });

  it("yields two NEWLINE_MARKERs for a single token containing '\\n\\n'", () => {
    const out = formatTokenViewText("a\n\nb", ["a\n\nb"]);
    const count = out.split(NEWLINE_MARKER).length - 1;
    expect(count).toBe(2);
    expect(out).toBe(`a${NEWLINE_MARKER}\n${NEWLINE_MARKER}\nb`);
  });

  it("does not strip a leading or trailing newline — that newline's marker is shown", () => {
    const out = formatTokenViewText("\nHello\n", ["\nHello\n"]);
    expect(out.startsWith(`${NEWLINE_MARKER}\n`)).toBe(true);
    expect(out.endsWith(`${NEWLINE_MARKER}\n`)).toBe(true);
  });

  it("marks a run of 2+ spaces, one SPACE_RUN_MARKER per space in the run", () => {
    const out = formatTokenViewText("a   b", ["a   b"]); // 3-space run
    expect(out).toBe(`a${SPACE_RUN_MARKER}${SPACE_RUN_MARKER}${SPACE_RUN_MARKER}b`);
  });

  it("leaves a single isolated space unmarked", () => {
    const out = formatTokenViewText("a b", ["a b"]);
    expect(out).toBe("a b");
    expect(out).not.toContain(SPACE_RUN_MARKER);
  });

  it("applies whitespace markers even with tokens=null (unavailable/pending sources)", () => {
    const out = formatTokenViewText("a\n\nb  c", null);
    expect(out).not.toContain(SEPARATOR);
    expect(out.split(NEWLINE_MARKER).length - 1).toBe(2);
    expect(out).toContain(`${SPACE_RUN_MARKER}${SPACE_RUN_MARKER}`);
  });

  it("handles a space run that spans a token boundary without breaking run detection", () => {
    // content-level run of 2 spaces split across two tokens.
    const out = formatTokenViewText("a  b", ["a ", " b"]);
    // Both spaces are still recognized as part of the same 2-run and marked,
    // with the real token boundary (SEPARATOR) inserted at its exact offset.
    expect(out).toBe(`a${SPACE_RUN_MARKER}${SEPARATOR}${SPACE_RUN_MARKER}b`);
  });

  it("degrades to unseparated rendering (tokens=null behavior) when tokens.join('') !== content, instead of inserting boundaries at fabricated offsets", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Deliberately mismatched: tokens join to "Hello" but content is "Hello world".
    const out = formatTokenViewText("Hello world", ["Hello"]);
    expect(out).not.toContain(SEPARATOR);
    // Falls through to the same output as an explicit tokens=null call.
    expect(out).toBe(formatTokenViewText("Hello world", null));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("resolveBoundarySource", () => {
  it("returns stream when contentTokens is defined, regardless of computedState", () => {
    const step = makeStep({ contentTokens: ["Hello", " world"] });
    const result = resolveBoundarySource(step, { status: "resolved", tokens: ["x"] });
    expect(result.source).toBe("stream");
    expect(result.tokens).toEqual(["Hello", " world"]);
  });

  it("returns unavailable with a reason when contentTokens is absent and no computedState is supplied", () => {
    const step = makeStep({ contentTokens: undefined });
    const result = resolveBoundarySource(step);
    expect(result.source).toBe("unavailable");
    expect(result.tokens).toEqual([]);
    expect(result.reason).toBeTruthy();
  });

  it("returns pending while a computed round trip is in flight", () => {
    const step = makeStep({ contentTokens: undefined });
    const result = resolveBoundarySource(step, { status: "pending" });
    expect(result.source).toBe("pending");
    expect(result.tokens).toEqual([]);
  });

  it("returns computed with tokens once the computed round trip resolves", () => {
    const step = makeStep({ contentTokens: undefined, content: "Hi" });
    const result = resolveBoundarySource(step, { status: "resolved", tokens: ["Hi"] });
    expect(result.source).toBe("computed");
    expect(result.tokens).toEqual(["Hi"]);
  });

  it("falls back to unavailable (never re-tokenizes) when the computed round trip errors", () => {
    const step = makeStep({ contentTokens: undefined });
    const result = resolveBoundarySource(step, { status: "error" });
    expect(result.source).toBe("unavailable");
    expect(result.reason).toBeTruthy();
  });

  it("degrades a resolved computed state to unavailable with a mismatch reason when tokens.join('') !== step.content (S2-F9), instead of labeling a mismatch as computed", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const step = makeStep({ contentTokens: undefined, content: "Hello world" });
    // Deliberately mismatched: joins to "Hello" but step.content is "Hello world".
    const result = resolveBoundarySource(step, { status: "resolved", tokens: ["Hello"] });
    expect(result.source).toBe("unavailable");
    expect(result.tokens).toEqual([]);
    expect(result.reason).toBe(COMPUTED_MISMATCH_REASON);
    // The label and rendering must agree: getBoundaryNotice must never
    // claim COMPUTED_LABEL for content that resolved as a mismatch.
    const notice = getBoundaryNotice(result);
    expect(notice?.label).not.toBe(COMPUTED_LABEL);
    expect(notice?.detail).toBe(COMPUTED_MISMATCH_REASON);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("accepts a resolved computed state whose tokens do join to step.content", () => {
    const step = makeStep({ contentTokens: undefined, content: "Hello world" });
    const result = resolveBoundarySource(step, { status: "resolved", tokens: ["Hello", " world"] });
    expect(result.source).toBe("computed");
    expect(result.tokens).toEqual(["Hello", " world"]);
  });
});

describe("useTokenBoundaries", () => {
  it("resolves stream immediately and reflects a growing contentTokens array under a stable step id", () => {
    const step = makeStep({ contentTokens: ["Hel"] });
    const { result, rerender } = renderHook(({ s }) => useTokenBoundaries(s), {
      initialProps: { s: step },
    });
    expect(result.current.source).toBe("stream");
    expect(result.current.tokens).toEqual(["Hel"]);

    // Same step id, array grown (as applyDelta's shallow-spread streaming does).
    const grown: ConversationStep = { ...step, contentTokens: ["Hel", "lo"] };
    rerender({ s: grown });
    expect(result.current.tokens).toEqual(["Hel", "lo"]);
  });

  it("resolves unavailable immediately with no computedSource configured", () => {
    const step = makeStep({ contentTokens: undefined });
    const { result } = renderHook(() => useTokenBoundaries(step));
    expect(result.current.source).toBe("unavailable");
  });

  it("fires the fetch when computedSource arrives on a step whose id and content are stable (S2-F8 arrival-edge regression)", async () => {
    // Reproduces S3's likely conditional wiring, e.g.
    // `computedSource={isOllama ? tokenizeFn : undefined}` — the provider
    // flips mid-conversation on a step that never itself changes. `key` is
    // `step.id:step.content`, so it does NOT change here; without a
    // presence signal in the effect's deps this transition is invisible
    // and the hook gets stuck at `pending` forever.
    const step = makeStep({ contentTokens: undefined, content: "Hi" });
    const fake = vi.fn(() => Promise.resolve(["Hi"]));

    type ArrivalProps = { computedSource?: (s: ConversationStep) => Promise<string[]> };
    const { result, rerender } = renderHook<TokenBoundaryResult, ArrivalProps>(
      ({ computedSource }) => useTokenBoundaries(step, { computedSource }),
      { initialProps: { computedSource: undefined } }
    );
    expect(result.current.source).toBe("unavailable");
    expect(fake).not.toHaveBeenCalled();

    // Same step (same id, same content) — only computedSource newly supplied.
    rerender({ computedSource: fake });

    await waitFor(() => expect(result.current.source).toBe("computed"));
    expect(result.current.tokens).toEqual(["Hi"]);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("goes pending then computed when a fake computedSource resolves (MOCK-02-001)", async () => {
    const step = makeStep({ contentTokens: undefined, content: "Hi" });
    let resolveFake!: (tokens: string[]) => void;
    const fake = vi.fn(() => new Promise<string[]>((resolve) => { resolveFake = resolve; }));

    const { result } = renderHook(() => useTokenBoundaries(step, { computedSource: fake }));
    expect(result.current.source).toBe("pending");

    await act(async () => {
      resolveFake(["Hi"]);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.source).toBe("computed"));
    expect(result.current.tokens).toEqual(["Hi"]);
  });

  it("falls back to unavailable when the fake computedSource rejects", async () => {
    const step = makeStep({ contentTokens: undefined, content: "Hi" });
    const fake = vi.fn(() => Promise.reject(new Error("boom")));

    const { result } = renderHook(() => useTokenBoundaries(step, { computedSource: fake }));
    await waitFor(() => expect(result.current.source).toBe("unavailable"));
  });

  it("ignores a stale in-flight computed response after the step's content changes", async () => {
    let resolveSlow!: (tokens: string[]) => void;
    const slow = vi.fn(() => new Promise<string[]>((resolve) => { resolveSlow = resolve; }));
    const fast = vi.fn(() => Promise.resolve(["BBB"]));

    const stepA = makeStep({ contentTokens: undefined, content: "AAA" });
    const { result, rerender } = renderHook(
      ({ s, computedSource }) => useTokenBoundaries(s, { computedSource }),
      { initialProps: { s: stepA, computedSource: slow } }
    );
    expect(result.current.source).toBe("pending");

    const stepB = makeStep({ contentTokens: undefined, content: "BBB" });
    rerender({ s: stepB, computedSource: fast });
    await waitFor(() => expect(result.current.source).toBe("computed"));
    expect(result.current.tokens).toEqual(["BBB"]);

    // The stale slow() response resolves after the fact — must not clobber B's result.
    await act(async () => {
      resolveSlow(["AAA"]);
      await Promise.resolve();
    });
    expect(result.current.tokens).toEqual(["BBB"]);
  });

  it("does not re-fire the fetch when the caller passes a brand-new computedSource identity on every render (S3 seam regression)", async () => {
    // Reproduces S3's natural production wiring: an inline lambda literal
    // passed as `computedSource`, e.g. `computedSource={(s) => tokenize(model,
    // s.content)}`. That expression has a new function identity every render.
    // Before the useRef fix, that identity sat in the fetch effect's
    // dependency array, so each render re-fired the effect -> setComputedState
    // -> re-render -> new identity -> unbounded loop. The underlying fake
    // must be invoked exactly once regardless of how many times the hook
    // re-renders with a fresh lambda.
    const step = makeStep({ contentTokens: undefined, content: "Hi" });
    const underlying = vi.fn((s: ConversationStep) => Promise.resolve([s.content]));

    const { result, rerender } = renderHook(
      () => useTokenBoundaries(step, { computedSource: (s) => underlying(s) }),
      { initialProps: {} }
    );
    expect(result.current.source).toBe("pending");

    await waitFor(() => expect(result.current.source).toBe("computed"));
    expect(underlying).toHaveBeenCalledTimes(1);

    // Several more renders, each supplying a fresh lambda identity.
    for (let i = 0; i < 5; i++) {
      rerender();
    }

    expect(underlying).toHaveBeenCalledTimes(1);
    expect(result.current.source).toBe("computed");
    expect(result.current.tokens).toEqual(["Hi"]);
  });
});

describe("getBoundaryNotice", () => {
  it("labels stream as 'stream boundaries' with a merge caveat, never claiming exact tokens", () => {
    const result: TokenBoundaryResult = { source: "stream", tokens: ["a"] };
    const notice = getBoundaryNotice(result);
    expect(notice?.label).toBe(STREAM_LABEL);
    expect(notice?.detail).toBe(STREAM_CAVEAT);
    expect(notice?.detail).toContain("not guaranteed");
  });

  it("labels computed with a standalone-tokenization notice, never claiming exact tokens", () => {
    const result: TokenBoundaryResult = { source: "computed", tokens: ["a"] };
    const notice = getBoundaryNotice(result);
    expect(notice?.label).toBe(COMPUTED_LABEL);
    expect(notice?.detail).toBe(COMPUTED_NOTICE);
    expect(notice?.detail).toContain("not the model's exact emitted tokens");
  });

  it("names a reason for unavailable", () => {
    const result: TokenBoundaryResult = { source: "unavailable", tokens: [], reason: UNAVAILABLE_REASON };
    const notice = getBoundaryNotice(result);
    expect(notice?.label).toBeTruthy();
    expect(notice?.detail).toBe(UNAVAILABLE_REASON);
  });

  it("renders no notice for pending, so toggling does not flash a reason for every step", () => {
    const result: TokenBoundaryResult = { source: "pending", tokens: [] };
    expect(getBoundaryNotice(result)).toBeNull();
  });
});

/**
 * End-to-end rendering contract, exercised against both the `stream` source
 * (real contentTokens) and MOCK-02-001's fake `computed` source, using a
 * minimal harness that mirrors chat-workspace.tsx's own consumption
 * pattern of these exports (single formatted string as a Typography's only
 * child — never one element per token).
 */
function TokenViewHarness({
  step,
  computedSource,
}: {
  step: ConversationStep;
  computedSource?: (step: ConversationStep) => Promise<string[]>;
}) {
  const boundary = useTokenBoundaries(step, { computedSource });
  const tokens = boundary.source === "stream" || boundary.source === "computed" ? boundary.tokens : null;
  const text = formatTokenViewText(step.content, tokens);
  const notice = getBoundaryNotice(boundary);
  return (
    <div>
      {notice ? <div data-testid="notice">{notice.label} — {notice.detail}</div> : null}
      <div data-testid="token-text">{text}</div>
    </div>
  );
}

describe("rendering contract (stream + MOCK-02-001 computed)", () => {
  it("renders a single text node with SEPARATOR between tokens for the stream source", () => {
    const step = makeStep({ contentTokens: ["Hello", " world"], content: "Hello world" });
    render(<TokenViewHarness step={step} />);
    const node = screen.getByTestId("token-text");
    expect(node.childNodes).toHaveLength(1);
    expect(node.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(node.textContent).toBe(`Hello${SEPARATOR} world`);
    expect(screen.getByTestId("notice").textContent).toContain(STREAM_LABEL);
  });

  it("renders a single text node with SEPARATOR between tokens for the injected computed source", async () => {
    const step = makeStep({ contentTokens: undefined, content: "Hi there" });
    const fake = vi.fn(() => Promise.resolve(["Hi", " there"]));
    render(<TokenViewHarness step={step} computedSource={fake} />);

    await waitFor(() => {
      expect(screen.getByTestId("token-text").textContent).toBe(`Hi${SEPARATOR} there`);
    });
    const node = screen.getByTestId("token-text");
    expect(node.childNodes).toHaveLength(1);
    expect(screen.getByTestId("notice").textContent).toContain(COMPUTED_LABEL);
  });

  it("renders unavailable with a visible reason and unseparated content, never re-tokenizing", () => {
    const step = makeStep({ contentTokens: undefined, content: "orphaned content" });
    render(<TokenViewHarness step={step} />);
    expect(screen.getByTestId("token-text").textContent).toBe("orphaned content");
    expect(screen.getByTestId("notice")).toBeTruthy();
    expect(screen.getByTestId("token-text").textContent).not.toContain(SEPARATOR);
  });

  it("renders pending with no notice", () => {
    const step = makeStep({ contentTokens: undefined, content: "in flight" });
    const neverResolves = vi.fn(() => new Promise<string[]>(() => {}));
    render(<TokenViewHarness step={step} computedSource={neverResolves} />);
    expect(screen.queryByTestId("notice")).toBeNull();
    expect(screen.getByTestId("token-text").textContent).toBe("in flight");
  });

  it("never shows a 'computed boundaries' label over unseparated content when the computed round trip's tokens don't join to step.content (S2-F9)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const step = makeStep({ contentTokens: undefined, content: "Hello world" });
    // Mismatched: joins to "Hello" only — as a wrong-source tokenize call
    // (AC-TOK-5) would produce.
    const fake = vi.fn(() => Promise.resolve(["Hello"]));
    render(<TokenViewHarness step={step} computedSource={fake} />);

    await waitFor(() => {
      expect(screen.getByTestId("notice")).toBeTruthy();
    });
    // Content renders unseparated...
    expect(screen.getByTestId("token-text").textContent).toBe("Hello world");
    expect(screen.getByTestId("token-text").textContent).not.toContain(SEPARATOR);
    // ...and the notice names the real reason, never the computed label —
    // label and rendering must agree.
    const notice = screen.getByTestId("notice").textContent ?? "";
    expect(notice).not.toContain(COMPUTED_LABEL);
    expect(notice).toContain(COMPUTED_MISMATCH_REASON);
    errorSpy.mockRestore();
  });
});
