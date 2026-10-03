/**
 * ContextMeter presentation (epic-compaction-tool S2): AC-UX-2, AC-UX-3, AC-UX-5, AC-UX-7
 * and the AC-UX-5 level boundaries as a property over fill and window, driven through the
 * real S1 producer `computeContextFill`.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { render, screen, cleanup } from "@testing-library/react";
import { ThemeRegistry } from "@/src/components/theme-registry";
import { ContextMeter } from "@/src/components/context-meter";
import { computeContextFill, type ContextFill, type ResolvedContextWindow } from "@/src/lib/context-window";

function renderMeter(fill: ContextFill | undefined, window: ResolvedContextWindow | undefined) {
  return render(
    <ThemeRegistry>
      <ContextMeter fill={fill} window={window} wide={false} />
    </ThemeRegistry>
  );
}

function fillOf(used: number, tokens: number): ContextFill {
  return computeContextFill([{ kind: "assistant", usage: { inputTokens: used, outputTokens: 0 } }], { tokens });
}

const runtimeWindow: ResolvedContextWindow = { tokens: 10000, source: "runtime" };

describe("ContextMeter", () => {
  it("shows en-US grouped tokens and the contextPercent percentage (AC-UX-2)", () => {
    renderMeter(fillOf(6120, 10000), runtimeWindow);
    expect(screen.getByTestId("context-meter")).toHaveTextContent("6,120 tokens · 61%");
  });

  it("shows 0 tokens and 0% before any response (AC-UX-2)", () => {
    renderMeter(computeContextFill([{ kind: "system" }], runtimeWindow), runtimeWindow);
    const meter = screen.getByTestId("context-meter");
    expect(meter).toHaveTextContent("0 tokens · 0%");
    expect(meter).toHaveAttribute("data-level", "ok");
  });

  it("shows a distinct loading marker and no level while the window is being resolved", () => {
    renderMeter(undefined, undefined);
    const meter = screen.getByTestId("context-meter");
    expect(meter).toHaveTextContent("…");
    expect(meter).not.toHaveTextContent("—");
    expect(screen.getByLabelText("Context usage loading")).toBeTruthy();
    expect(meter).not.toHaveTextContent("tokens");
    expect(meter).not.toHaveAttribute("data-level");
  });

  it.each([
    ["unknown fill", computeContextFill([{ kind: "assistant" }], runtimeWindow)],
    ["a usage-less tool-only response", computeContextFill([{ kind: "user" }, { kind: "tool_call", usage: { stopReason: "tool_calls" } }, { kind: "tool_result" }], runtimeWindow)],
  ])(
    "shows an em dash and no level for %s (AC-UX-3)",
    (_name, fill) => {
    renderMeter(fill, undefined);
    const meter = screen.getByTestId("context-meter");
    expect(meter).toHaveTextContent("—");
    expect(meter).not.toHaveTextContent("…");
    expect(meter).not.toHaveTextContent("tokens");
    expect(meter).not.toHaveTextContent("%");
    expect(meter).not.toHaveAttribute("data-level");
    }
  );

  it.each([
    [7900, 10000, "ok"],
    [7999, 10000, "ok"],
    [8000, 10000, "warn"],
    [9999, 10000, "warn"],
    [10000, 10000, "error"],
    [25000, 10000, "error"],
  ])("fill %i of window %i has level %s (AC-UX-5 boundaries)", (used, tokens, level) => {
    renderMeter(fillOf(used, tokens), { tokens, source: "runtime" });
    expect(screen.getByTestId("context-meter")).toHaveAttribute("data-level", level);
  });

  it("derives data-level from fill and window by the 80/100 percent bands for every pair (AC-UX-5)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 1, max: 2_000_000 }), (used, tokens) => {
        const { unmount } = renderMeter(fillOf(used, tokens), { tokens, source: "runtime" });
        const expected = used >= tokens ? "error" : used * 100 >= tokens * 80 ? "warn" : "ok";
        const meter = screen.getByTestId("context-meter");
        const level = meter.getAttribute("data-level");
        const text = meter.textContent ?? "";
        unmount();
        // Never NaN/Infinity, whatever the proportions.
        return level === expected && !/NaN|Infinity/.test(text);
      }),
      { numRuns: 60 }
    );
  });

  it.each([
    [{ tokens: 8192, source: "estimated" as const }, "estimated"],
    [{ tokens: 8192, source: "assumed" as const }, "assumed"],
    [{ tokens: 8192, source: "runtime" as const, stale: true }, "stale"],
  ])("labels the window provenance %j as %s (AC-UX-7)", (window, word) => {
    renderMeter(fillOf(10, 8192), window);
    expect(screen.getByTestId("context-meter-source")).toHaveTextContent(word);
  });

  it.each([
    { tokens: 8192, source: "runtime" as const },
    { tokens: 8192, source: "modelfile" as const },
  ])("adds no label for a firm window %j and never shows the window size (AC-UX-7, spec)", (window) => {
    renderMeter(fillOf(10, 8192), window);
    expect(screen.queryByTestId("context-meter-source")).toBeNull();
    expect(screen.getByTestId("context-meter").textContent).not.toMatch(/8,?192/);
    cleanup();
  });
});

describe("ContextMeter progress bar semantics (mutation audit)", () => {
  it.each<[string, ContextFill | undefined, string | null, string]>([
    ["a half-full context", fillOf(5000, 10000), "50", "50% used, ok"],
    ["an overfull context (clamped to a full bar)", fillOf(11000, 10000), "100", "110% used, error"],
    ["a loading meter", undefined, "0", "loading"],
    ["an unknown fill", computeContextFill([{ kind: "assistant" }], runtimeWindow), "0", "unknown"],
  ])("%s exposes its value and text to assistive technology", (_name, fill, valueNow, valueText) => {
    renderMeter(fill, runtimeWindow);
    const bar = screen.getByRole("progressbar", { name: "Context used" });
    expect(bar.getAttribute("aria-valuenow")).toBe(valueNow);
    expect(bar).toHaveAttribute("aria-valuetext", valueText);
    cleanup();
  });
});
