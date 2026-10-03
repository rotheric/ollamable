/**
 * Preview parity for the usage note (compaction-tool S4, AC-NOTE-6/8): the request JSON dialog,
 * toOllamaFilteredMessages, useReconciliation and the preview extras apply the same transform as
 * the server's tool loop, with the note rebuilt from the steps before the target.
 */
import { describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import type { Conversation, ConversationStep, OllamaModel, ToolDefinition } from "@/src/types/chat";
import { RequestJsonDialog } from "@/src/components/request-json-dialog";
import { RequestPreviewExtras } from "@/src/components/request-preview-extras";
import { toOllamaFilteredMessages, useReconciliation } from "@/src/lib/token-view";
import { buildContextUsageNote } from "../../shared/context-usage";

vi.mock("@/src/lib/ollama", () => ({ fetchModelMeta: vi.fn().mockResolvedValue({ name: "m", template: "t" }) }));

const COMPACT: ToolDefinition = { id: "compact-context", name: "compact_context", description: "d", inputSchema: "{}" };
const OTHER: ToolDefinition = { id: "curl", name: "curl", description: "d", inputSchema: "{}" };
const WINDOW = { tokens: 8192, source: "runtime" as const };
const MODEL: OllamaModel = { name: "qwen3:latest", provider: "ollama", family: "qwen3" };

function step(kind: ConversationStep["kind"], content: string, extra: Partial<ConversationStep> = {}): ConversationStep {
  return { id: `${kind}-${content}`, kind, title: kind, content, createdAt: "2026-01-01T00:00:00.000Z", ...extra };
}

const steps = [
  step("system", "be terse"),
  step("user", "q1"),
  step("assistant", "a1", { usage: { inputTokens: 6000, outputTokens: 120 } }),
  step("user", "q2"),
];
const note = buildContextUsageNote({ usedTokens: 6120, windowTokens: 8192, source: "runtime" });

function conversation(): Conversation {
  return { id: "c", title: "t", model: "qwen3:latest", provider: "ollama", systemPrompt: "", createdAt: "", updatedAt: "", availableTools: [], activeToolIds: [], steps } as unknown as Conversation;
}

function dialogMessages(activeTools: ToolDefinition[]) {
  render(
    <RequestJsonDialog
      open
      onClose={() => undefined}
      conversation={conversation()}
      model={MODEL}
      activeTools={activeTools}
      contextWindow={WINDOW}
      showTokens={false}
      tokenizeText={vi.fn()}
    />
  );
  const text = screen.getByText(/"messages"/, { selector: "pre, code, div, span" }).textContent!;
  return (JSON.parse(text) as { messages: Array<{ role: string; content: string }> }).messages;
}

describe("request preview and the usage note", () => {
  it("AC-NOTE-6: the request JSON carries the note collated onto the last user message while compact_context is active", () => {
    const messages = dialogMessages([COMPACT]);
    expect(messages).toHaveLength(4);
    expect(messages[3]).toEqual({ role: "user", content: `q2\n\n${note}` });
  });

  it("AC-NOTE-6/4: no note in the request JSON without compact_context", () => {
    const messages = dialogMessages([OTHER]);
    expect(messages[3]).toEqual({ role: "user", content: "q2" });
  });

  it("AC-NOTE-8: toOllamaFilteredMessages applies the same transform (merged last-user index) and is note-free by default", () => {
    const placed = toOllamaFilteredMessages(steps, { activeTools: [COMPACT], contextWindow: WINDOW, family: "qwen3" });
    expect(placed.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(placed[3].content).toBe(`q2\n\n${note}`);
    expect(toOllamaFilteredMessages(steps)[3].content).toBe("q2");
    expect(toOllamaFilteredMessages(steps, { activeTools: [OTHER], contextWindow: WINDOW })[3].content).toBe("q2");
  });

  it("maps a compaction step the same way in the preview list (no note needed)", () => {
    const fork = [step("system", "s"), step("compaction" as ConversationStep["kind"], "SUMMARY"), step("user", "go")] as ConversationStep[];
    expect(toOllamaFilteredMessages(fork)).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "SUMMARY\n\ngo" },
    ]);
  });

  it("AC-NOTE-8: useReconciliation tokenizes preceding messages that include the note rebuilt from the steps before the target", async () => {
    const withTarget = [
      step("system", "be terse"),
      step("user", "q1"),
      step("assistant", "a1", { usage: { inputTokens: 6000, outputTokens: 120 } }),
      step("user", "q2"),
      step("assistant", "a2", { usage: { inputTokens: 6500, outputTokens: 40 } }),
    ];
    const seen: string[] = [];
    const tokenizeText = vi.fn((text: string) => {
      seen.push(text);
      return Promise.resolve(text.split(" "));
    });
    const placement = { activeTools: [COMPACT], contextWindow: WINDOW, family: "qwen3" };
    const { result } = renderHook(() => useReconciliation(withTarget, tokenizeText, true, "k", undefined, placement));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    // The request that produced a2 saw q2 plus the note built from a1's usage (6,120), not a2's.
    expect(seen).toContain(`q2\n\n${note}`);
    expect(seen.some((text) => text.includes("6,620"))).toBe(false);
  });

  it("AC-NOTE-8: the preview extras list the note in the outgoing message and never as a separate transcript step", async () => {
    render(
      <RequestPreviewExtras open steps={steps} model={MODEL} activeTools={[COMPACT]} contextWindow={WINDOW} tokenizeText={vi.fn().mockResolvedValue(["x"])} />
    );
    const rows = await screen.findAllByTestId("outgoing-message");
    expect(rows).toHaveLength(4);
    expect(rows[3].textContent).toContain("Automatic note from the app");
    expect(rows.filter((row) => row.textContent?.includes("Automatic note"))).toHaveLength(1);
  });
});
