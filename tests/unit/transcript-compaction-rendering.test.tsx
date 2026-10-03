/**
 * Transcript rendering of compaction artifacts and per-step actions, driven through the
 * public <Transcript> component (mutation audit of the compaction-tool epic: the fork-origin
 * link, the harness event card, compaction markdown, the examples gate and the step callbacks
 * were rendered by ChatWorkspace tests but never asserted at this level).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Transcript } from "@/src/components/transcript";
import type { Conversation, ConversationStep, MetaEventKind } from "@/src/types/chat";

const at = "2026-01-01T00:00:00.000Z";

function step(id: string, kind: ConversationStep["kind"], content: string, extra: Partial<ConversationStep> = {}): ConversationStep {
  return { id, kind, title: kind, content, createdAt: at, expanded: true, ...extra };
}

function conversation(steps: ConversationStep[], extra: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv",
    title: "Conv",
    model: "qwen3:latest",
    systemPrompt: "",
    createdAt: at,
    updatedAt: at,
    steps,
    availableTools: [],
    activeToolIds: [],
    ...extra,
  } as Conversation;
}

function renderTranscript(conv: Conversation, extra: Partial<Parameters<typeof Transcript>[0]> = {}) {
  const props = {
    conversation: conv,
    activeTools: [],
    error: "",
    wide: false,
    streaming: false,
    canResume: false,
    autoScroll: false,
    hideSystemPrompt: false,
    showExamples: false,
    showTokens: false,
    renderMarkdown: false,
    tokenizeText: async () => [],
    onSystemPromptChange: vi.fn(),
    onToggleStep: vi.fn(),
    onExpandStep: vi.fn(),
    onEditUserStep: vi.fn(),
    onResendUserStep: vi.fn(),
    onRegenerateAssistantStep: vi.fn(),
    onDeleteLastExchange: vi.fn(),
    onResume: vi.fn(),
    onNavigateToTool: vi.fn(),
    onOpenConversation: vi.fn(),
    ...extra,
  };
  const view = render(<Transcript {...props} />);
  return { ...view, props };
}

const card = (container: HTMLElement, kind: string) => [...container.querySelectorAll(`[data-step-kind="${kind}"]`)] as HTMLElement[];

const harness = (data: Record<string, unknown> | undefined, kind: MetaEventKind = "compaction") =>
  step("h1", "meta", "Context compacted by the app — continued in “Fork”", {
    metaEvent: { kind, title: "Context compacted", detail: "", ...(data ? { data } : {}) },
  });

describe("fork origin link (AC-FORK-8)", () => {
  it("is shown once, above the compaction card of a forked conversation, and opens the original", async () => {
    const conv = conversation(
      [step("s1", "user", "hi"), step("c1", "compaction", "summary"), step("a1", "assistant", "ok")],
      { forkedFrom: { conversationId: "orig", stepId: "t1" } }
    );
    const { props } = renderTranscript(conv, { forkOrigin: { id: "orig", title: "Original" } });
    const links = screen.getAllByTestId("fork-origin-link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent("Compacted from “Original”");
    await userEvent.click(links[0]);
    expect(props.onOpenConversation).toHaveBeenCalledWith("orig");
  });

  it("is absent for a compaction step in a conversation that was not forked", () => {
    renderTranscript(conversation([step("c1", "compaction", "summary")]), { forkOrigin: { id: "orig", title: "Original" } });
    expect(screen.queryByTestId("fork-origin-link")).toBeNull();
    expect(screen.queryByTestId("fork-origin-missing")).toBeNull();
  });
});

describe("compaction and harness cards", () => {
  it("renders the compaction summary as markdown when markdown rendering is on", () => {
    const { container } = renderTranscript(conversation([step("c1", "compaction", "**kept** facts")]), { renderMarkdown: true });
    expect(within(card(container, "compaction")[0]).getByText("kept").tagName).toBe("STRONG");
  });

  it("shows the compaction summary verbatim when markdown rendering is off", () => {
    const { container } = renderTranscript(conversation([step("c1", "compaction", "**kept** facts")]), { renderMarkdown: false });
    expect(card(container, "compaction")[0]).toHaveTextContent("**kept** facts");
  });

  it("a tool_call card shows the call, never the step's raw text", () => {
    const { container } = renderTranscript(
      conversation([step("t1", "tool_call", "RAW-TEXT", { toolCall: { id: "k", name: "web_search", arguments: { q: "x" } } })])
    );
    expect(card(container, "tool_call")[0]).not.toHaveTextContent("RAW-TEXT");
  });

  it("keeps tool results as pretty-printed JSON even when markdown rendering is on", () => {
    const { container } = renderTranscript(
      conversation([step("r1", "tool_result", '{"a":1}', { toolResult: { id: "k", name: "web_search" } })]),
      { renderMarkdown: true }
    );
    expect(card(container, "tool_result")[0].textContent).toContain('"a": 1');
  });

  it("offers Inspect for chat messages but not for compaction, meta or reasoning cards", () => {
    const { container } = renderTranscript(
      conversation([step("u1", "user", "hi"), step("r1", "reasoning", "think"), step("c1", "compaction", "s"), harness({ forkConversationId: "f" }), step("a1", "assistant", "ok")])
    );
    const inspectIn = (kind: string) => card(container, kind).map((el) => within(el).queryByLabelText("Inspect OpenAI message") !== null);
    expect(inspectIn("user")).toEqual([true]);
    expect(inspectIn("assistant")).toEqual([true]);
    expect(inspectIn("reasoning")).toEqual([false]);
    expect(inspectIn("compaction")).toEqual([false]);
    expect(inspectIn("meta")).toEqual([false]);
  });

  it("the harness card names the fork once and its link opens the fork", async () => {
    const find = vi.fn((id: string) => (id === "fork-1" ? "Fork" : undefined));
    const { container, props } = renderTranscript(conversation([step("u1", "user", "hi"), harness({ forkConversationId: "fork-1" })]), {
      findConversationTitle: find,
    });
    const meta = card(container, "meta")[0];
    expect(meta.textContent!.split("continued in").length - 1).toBe(1);
    await userEvent.click(within(meta).getByTestId("compaction-fork-link"));
    expect(props.onOpenConversation).toHaveBeenCalledWith("fork-1");
  });

  it("renders the harness text without a link when no title lookup is available", () => {
    const { container } = renderTranscript(conversation([harness({ forkConversationId: "fork-1" })]));
    const meta = card(container, "meta")[0];
    expect(within(meta).getByTestId("compaction-harness-event")).toHaveTextContent("continued in");
    expect(within(meta).queryByTestId("compaction-fork-link")).toBeNull();
  });

  it.each([
    ["an empty fork id", harness({ forkConversationId: "" })],
    ["a non-string fork id", harness({ forkConversationId: 7 })],
    ["no data", harness(undefined)],
    ["another meta event", harness({ forkConversationId: "fork-1" }, "mcp_call")],
    ["a meta step without an event", step("m1", "meta", "plain")],
  ])("%s is not a harness card", (_name, meta) => {
    renderTranscript(conversation([meta]), { findConversationTitle: () => "Anything" });
    expect(screen.queryByTestId("compaction-harness-event")).toBeNull();
    expect(screen.queryByTestId("compaction-fork-link")).toBeNull();
  });
});

describe("system prompt examples gate", () => {
  it.each<[string, ConversationStep[], boolean, boolean]>([
    ["an empty conversation", [], false, true],
    ["a conversation holding only its system step", [step("y1", "system", "be brief")], false, true],
    ["a conversation with a user message", [step("u1", "user", "hi")], false, false],
    ["a fork that starts with a compaction step", [step("c1", "compaction", "s")], false, false],
    ["a hidden system prompt", [], true, false],
  ])("%s", (_name, steps, hideSystemPrompt, shown) => {
    renderTranscript(conversation(steps), { showExamples: true, hideSystemPrompt });
    expect(screen.queryByTestId("system-prompt-examples") !== null).toBe(shown);
  });
});

describe("per-step actions reach the right step", () => {
  const steps = [step("u1", "user", "first"), step("a1", "assistant", "one"), step("u2", "user", "second"), step("a2", "assistant", "two")];

  it("only the last chat message can be deleted", () => {
    const { container } = renderTranscript(conversation(steps));
    const deletable = [...card(container, "user"), ...card(container, "assistant")].filter((el) => within(el).queryByLabelText("Delete message"));
    expect(deletable).toHaveLength(1);
    expect(deletable[0]).toHaveTextContent("two");
  });

  it("toggling, resending and inspecting act on the clicked step", async () => {
    const { container, props } = renderTranscript(conversation(steps));
    const second = card(container, "user")[1];
    await userEvent.click(within(second).getByText("user"));
    expect(props.onToggleStep).toHaveBeenCalledWith("u2");
    await userEvent.click(within(second).getByLabelText("Resend message"));
    expect(props.onResendUserStep).toHaveBeenCalledWith("u2");
    await userEvent.click(within(second).getByLabelText("Inspect OpenAI message"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("second");
  });
});
