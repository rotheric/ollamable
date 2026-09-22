/**
 * Component tests for src/components/request-preview-extras.tsx — the
 * request-preview panel's │-separated outgoing messages, verbatim
 * chat-template display, and content-token reconciliation readout
 * (epic-token-view story S4).
 *
 * Covers AC-UX-5, AC-UX-6, and VQ-S4-006 (template rendered as literal
 * text, never dangerouslySetInnerHTML). Exercises the REAL component
 * tree (not a mock-spy proxy) so the rendered DOM text is what's
 * asserted, per VQ-S4-007(c).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ConversationStep, OllamaModel } from "@/src/types/chat";
import { SEPARATOR } from "@/src/lib/token-view";

const { mockFetchModelMeta } = vi.hoisted(() => ({
  mockFetchModelMeta: vi.fn(),
}));

vi.mock("@/src/lib/ollama", () => ({
  fetchModelMeta: mockFetchModelMeta,
}));

import { RequestPreviewExtras } from "@/src/components/request-preview-extras";

const MODEL: OllamaModel = { name: "qwen3:latest", provider: "ollama" };

function step(overrides: Partial<ConversationStep> & { kind: ConversationStep["kind"] }): ConversationStep {
  return {
    id: Math.random().toString(36).slice(2),
    title: "",
    content: "",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("RequestPreviewExtras", () => {
  beforeEach(() => {
    mockFetchModelMeta.mockReset();
    mockFetchModelMeta.mockResolvedValue({ name: "qwen3:latest", template: "{{ .System }}\n{{ .Prompt }}" });
  });

  it("AC-UX-5: renders outgoing messages with │ separators via token-view.ts's SEPARATOR/formatTokenViewText, and the template verbatim from /api/show", async () => {
    // Splits on whitespace runs as their own token, so tokens.join("") ===
    // content holds (formatTokenViewText's precondition) while still
    // producing more than one boundary to assert on.
    const tokenizeText = vi.fn((text: string) => Promise.resolve(text.match(/\S+|\s+/g) ?? [text]));
    const steps = [step({ kind: "user", content: "hi there" })];

    render(
      <RequestPreviewExtras open steps={steps} model={MODEL} tokenizeText={tokenizeText} />
    );

    await waitFor(() => {
      const message = screen.getByTestId("outgoing-message");
      expect(message.textContent).toBe(`user: hi${SEPARATOR} ${SEPARATOR}there`);
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-template").textContent).toBe("{{ .System }}\n{{ .Prompt }}");
    });
    expect(mockFetchModelMeta).toHaveBeenCalledWith(MODEL);
  });

  it("AC-UX-5: the template is rendered as literal text, never interpreted as HTML/markdown (VQ-S4-006)", async () => {
    mockFetchModelMeta.mockResolvedValue({
      name: "qwen3:latest",
      template: "<script>window.__pwned = true</script>",
    });
    render(<RequestPreviewExtras open steps={[]} model={MODEL} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-template").textContent).toBe(
        "<script>window.__pwned = true</script>"
      );
    });
    expect(document.querySelector("script[src]")).toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("AC-UX-6: displays content-token count, prompt_eval_count, and their difference labelled 'chat-template overhead' — never mismatch/error/warning", async () => {
    const tokenizeText = vi.fn((text: string) => Promise.resolve(text.match(/\S+|\s+/g) ?? [text]));
    const steps = [
      step({ kind: "system", content: "be terse" }),
      step({ kind: "user", content: "hi there" }),
      step({ kind: "assistant", content: "hello", usage: { inputTokens: 30 } }),
    ];

    render(<RequestPreviewExtras open steps={steps} model={MODEL} tokenizeText={tokenizeText} />);

    const figures = await screen.findByTestId("reconciliation-figures");
    expect(figures.textContent).toContain("Content tokens: 6");
    expect(figures.textContent).toContain("prompt_eval_count: 30");
    expect(figures.textContent).toContain("chat-template overhead: 24");
    expect(figures.textContent?.toLowerCase()).not.toMatch(/mismatch|error|warning/);
    expect(screen.queryByTestId("reconciliation-unavailable")).not.toBeInTheDocument();
  });

  it("AC-UX-6 (legacy standalone tool_call step, e.g. tour/example conversations): a turn containing a tool_call reports reconciliation-unavailable with a named reason, not a partial count", async () => {
    const tokenizeText = vi.fn((text: string) => Promise.resolve(text.match(/\S+|\s+/g) ?? [text]));
    const steps = [
      step({ kind: "user", content: "weather?" }),
      step({ kind: "tool_call", content: "" }),
      step({ kind: "tool_result", content: "sunny" }),
      step({ kind: "assistant", content: "It's sunny.", usage: { inputTokens: 40 } }),
    ];

    render(<RequestPreviewExtras open steps={steps} model={MODEL} tokenizeText={tokenizeText} />);

    const notice = await screen.findByTestId("reconciliation-unavailable");
    expect(notice.textContent).toMatch(/tool call/i);
    expect(screen.queryByTestId("reconciliation-figures")).not.toBeInTheDocument();
  });

  it("AC-UX-6 (merged shape the live server actually persists — ws-handler.ts folds tool_call steps into assistant.toolCalls[]): a turn containing a tool call reports reconciliation-unavailable with a named reason, not a partial count", async () => {
    const tokenizeText = vi.fn((text: string) => Promise.resolve(text.match(/\S+|\s+/g) ?? [text]));
    const steps = [
      step({ kind: "user", content: "weather?" }),
      step({ kind: "assistant", content: "", toolCalls: [{ name: "get_weather", arguments: {} }] }),
      step({ kind: "tool_result", content: "sunny" }),
      step({ kind: "assistant", content: "It's sunny.", usage: { inputTokens: 40 } }),
    ];

    render(<RequestPreviewExtras open steps={steps} model={MODEL} tokenizeText={tokenizeText} />);

    const notice = await screen.findByTestId("reconciliation-unavailable");
    expect(notice.textContent).toMatch(/tool call/i);
    expect(screen.queryByTestId("reconciliation-figures")).not.toBeInTheDocument();
  });

  it("S4-F6: an unresolvable model (previewModel undefined) shows a named reason instead of 'Loading…' forever", async () => {
    render(<RequestPreviewExtras open steps={[]} model={undefined} />);

    const notice = await screen.findByTestId("template-error");
    expect(notice.textContent).toMatch(/model is not in the current model list/i);
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(mockFetchModelMeta).not.toHaveBeenCalled();
  });

  it("S4-F3: a failed tokenize round trip for the outgoing-message list carries a named reason instead of silently dropping separators", async () => {
    const tokenizeText = vi.fn().mockRejectedValue(new Error("tokenize.error"));
    const steps = [step({ kind: "user", content: "hi there" })];

    render(<RequestPreviewExtras open steps={steps} model={MODEL} tokenizeText={tokenizeText} />);

    const notice = await screen.findByTestId("outgoing-messages-failed");
    expect(notice.textContent).toMatch(/failed/i);
    const message = screen.getByTestId("outgoing-message");
    expect(message.textContent).toBe("user: hi there");
  });

  it("S4-F4: the reconciliation figures are labelled with their scope (the last completed turn), distinct from the outgoing-message list above them", async () => {
    const tokenizeText = vi.fn((text: string) => Promise.resolve(text.match(/\S+|\s+/g) ?? [text]));
    const steps = [
      step({ kind: "system", content: "be terse" }),
      step({ kind: "user", content: "hi there" }),
      step({ kind: "assistant", content: "hello", usage: { inputTokens: 30 } }),
    ];

    render(<RequestPreviewExtras open steps={steps} model={MODEL} tokenizeText={tokenizeText} />);

    await screen.findByTestId("reconciliation-figures");
    expect(screen.getByText("Reconciliation for the last completed turn")).toBeInTheDocument();
  });

  it("does not fetch the template or tokenize while closed", () => {
    const tokenizeText = vi.fn();
    render(
      <RequestPreviewExtras
        open={false}
        steps={[step({ kind: "user", content: "hi" })]}
        model={MODEL}
        tokenizeText={tokenizeText}
      />
    );
    expect(mockFetchModelMeta).not.toHaveBeenCalled();
    expect(tokenizeText).not.toHaveBeenCalled();
  });
});

/**
 * Gap-closing tests derived from a Stryker audit of
 * src/components/request-preview-extras.tsx (2026-09-22, first pass:
 * score 0.459, 34 survivors / 6 NoCoverage).
 *
 * The suite above asserts the panel's happy paths and its two named
 * "cannot show this" reasons. What it never exercised is what the panel
 * does when the conversation's model *changes underneath it*, when the
 * template round trip *fails* (the whole `.catch` branch was NoCoverage),
 * and when reconciliation ends in `error` rather than `unavailable`.
 * Each of those is a state a user actually reaches — switching models
 * mid-conversation, a backend that drops the /show call, a tokenize
 * round trip that times out — and each was assertion-free.
 *
 * AC linkage: the template-failure and model-switch behaviours extend
 * AC-UX-5 (the panel MUST display the template as returned by
 * POST /api/show — which presupposes saying so when it cannot) and
 * S4-F6's "must not sit on Loading… forever with no explanation". The
 * reconciliation-error state and the shared tokenize cache (S4-F5) have
 * no AC of their own; they are reported as spec gaps by the audit that
 * produced this block.
 */
describe("RequestPreviewExtras — what the panel says when things change or go wrong", () => {
  beforeEach(() => {
    mockFetchModelMeta.mockReset();
    mockFetchModelMeta.mockResolvedValue({ name: "qwen3:latest", template: "{{ .Prompt }}" });
  });

  it("says the template is still on its way, rather than showing a blank panel, while the model is being described", async () => {
    let release: (meta: { name: string; template: string }) => void = () => {};
    mockFetchModelMeta.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    render(<RequestPreviewExtras open steps={[]} model={MODEL} />);

    expect(screen.getByTestId("chat-template").textContent).toBe("Loading…");

    release({ name: "qwen3:latest", template: "{{ .Prompt }}" });
    await waitFor(() => {
      expect(screen.getByTestId("chat-template").textContent).toBe("{{ .Prompt }}");
    });
  });

  it("names the failure when the model cannot be described, instead of sitting on 'Loading…'", async () => {
    mockFetchModelMeta.mockRejectedValue(new Error("Ollama /show failed: 500"));

    render(<RequestPreviewExtras open steps={[]} model={MODEL} />);

    const notice = await screen.findByTestId("template-error");
    expect(notice.textContent).toContain("Ollama /show failed: 500");
    expect(screen.getByTestId("chat-template").textContent).toBe("");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("still names a failure that arrives without a message, rather than falling back to silence", async () => {
    mockFetchModelMeta.mockRejectedValue("a bare string rejection");

    render(<RequestPreviewExtras open steps={[]} model={MODEL} />);

    const notice = await screen.findByTestId("template-error");
    expect(notice.textContent).toMatch(/failed to load chat template/i);
  });

  it("describes the newly selected model, not the one the panel opened on", async () => {
    mockFetchModelMeta.mockImplementation((model: OllamaModel) =>
      Promise.resolve({ name: model.name, template: `template for ${model.name}` })
    );
    const other: OllamaModel = { name: "llama3:8b", provider: "ollama" };

    const { rerender } = render(<RequestPreviewExtras open steps={[]} model={MODEL} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-template").textContent).toBe("template for qwen3:latest");
    });

    rerender(<RequestPreviewExtras open steps={[]} model={other} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-template").textContent).toBe("template for llama3:8b");
    });
  });

  it("clears an earlier failure once a model that can be described is selected", async () => {
    const { rerender } = render(<RequestPreviewExtras open steps={[]} model={undefined} />);
    await screen.findByTestId("template-error");

    rerender(<RequestPreviewExtras open steps={[]} model={MODEL} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-template").textContent).toBe("{{ .Prompt }}");
    });
    expect(screen.queryByTestId("template-error")).not.toBeInTheDocument();
  });

  it("stops showing a template that no longer belongs to the conversation's model once that model becomes unresolvable", async () => {
    const { rerender } = render(<RequestPreviewExtras open steps={[]} model={MODEL} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-template").textContent).toBe("{{ .Prompt }}");
    });

    rerender(<RequestPreviewExtras open steps={[]} model={undefined} />);

    const notice = await screen.findByTestId("template-error");
    expect(notice.textContent).toMatch(/model is not in the current model list/i);
    // The stale template must not keep sitting there under the warning,
    // where it reads as the current model's wire format.
    expect(screen.getByTestId("chat-template").textContent).toBe("");
  });

  it("F6: clears model A's stale template immediately on switching to model B, rather than leaving it displayed beneath B's error when B's fetch rejects", async () => {
    let releaseB: (() => void) | null = null;
    mockFetchModelMeta.mockImplementation((model: OllamaModel) => {
      if (model.name === "llama3:8b") {
        return new Promise((_resolve, reject) => {
          releaseB = () => reject(new Error("Ollama /show failed: 500"));
        });
      }
      return Promise.resolve({ name: model.name, template: `template for ${model.name}` });
    });
    const other: OllamaModel = { name: "llama3:8b", provider: "ollama" };

    const { rerender } = render(<RequestPreviewExtras open steps={[]} model={MODEL} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-template").textContent).toBe("template for qwen3:latest");
    });

    rerender(<RequestPreviewExtras open steps={[]} model={other} />);
    // A's template must be gone the instant B's fetch starts, not only
    // once B's fetch settles — the panel is describing B now, even while
    // B's own answer is still in flight.
    expect(screen.getByTestId("chat-template").textContent).toBe("Loading…");

    releaseB!();
    const notice = await screen.findByTestId("template-error");
    expect(notice.textContent).toContain("Ollama /show failed: 500");
    // A's stale template must not resurface underneath B's error either.
    expect(screen.getByTestId("chat-template").textContent).toBe("");
  });

  it("F6: names a model that resolves with no chat template, rather than sitting on 'Loading…' forever", async () => {
    mockFetchModelMeta.mockResolvedValue({ name: "qwen3:latest", template: undefined });

    render(<RequestPreviewExtras open steps={[]} model={MODEL} />);

    const notice = await screen.findByTestId("template-absent");
    expect(notice.textContent).toMatch(/no chat template/i);
    expect(screen.getByTestId("chat-template").textContent).toBe("");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("says reconciliation could not run when the round trip it needs fails, rather than showing figures derived from nothing", async () => {
    const tokenizeText = vi.fn().mockRejectedValue(new Error("tokenize.error"));
    const steps = [
      step({ kind: "system", content: "be terse" }),
      step({ kind: "user", content: "hi there" }),
      step({ kind: "assistant", content: "hello", usage: { inputTokens: 30 } }),
    ];

    render(<RequestPreviewExtras open steps={steps} model={MODEL} tokenizeText={tokenizeText} />);

    const notice = await screen.findByTestId("reconciliation-error");
    expect(notice.textContent).toMatch(/could not run/i);
    expect(screen.queryByTestId("reconciliation-figures")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reconciliation-unavailable")).not.toBeInTheDocument();
    // The section is still announced — a user who was looking at figures
    // a moment ago should see why they are gone, not an unlabelled alert.
    expect(screen.getByText("Reconciliation for the last completed turn")).toBeInTheDocument();
  });

  it("does not announce a reconciliation section for a conversation that has never completed a turn", async () => {
    const tokenizeText = vi.fn((text: string) => Promise.resolve(text.match(/\S+|\s+/g) ?? [text]));
    const steps = [step({ kind: "user", content: "hi there" })];

    render(<RequestPreviewExtras open steps={steps} model={MODEL} tokenizeText={tokenizeText} />);

    await screen.findByTestId("outgoing-message");
    expect(screen.queryByText("Reconciliation for the last completed turn")).not.toBeInTheDocument();
  });

  it("asks the tokenizer about each distinct message once, even though the outgoing list and the completed turn overlap (S4-F5)", async () => {
    const tokenizeText = vi.fn((text: string) => Promise.resolve(text.match(/\S+|\s+/g) ?? [text]));
    const steps = [
      step({ kind: "system", content: "be terse" }),
      step({ kind: "user", content: "hi there" }),
      step({ kind: "assistant", content: "hello", usage: { inputTokens: 30 } }),
    ];

    render(<RequestPreviewExtras open steps={steps} model={MODEL} tokenizeText={tokenizeText} />);
    await screen.findByTestId("reconciliation-figures");

    // The reconciliation readout covers the steps preceding the assistant
    // step; the outgoing list covers all of them. Overlapping content must
    // cost one round trip, not two.
    const asked = tokenizeText.mock.calls.map(([text]) => text);
    expect(new Set(asked).size).toBe(asked.length);
  });
});
