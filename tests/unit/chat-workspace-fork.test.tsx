/**
 * Fork and auto-continue through the real ChatWorkspace tree (epic-compaction-tool S6):
 * AC-FORK-1..8. Only the websocket and the backend client are mocked; the mocked client delivers the
 * compaction payload the way the real one does, before the stream promise resolves.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeRegistry } from "@/src/components/theme-registry";
import { ChatWorkspace } from "@/src/components/chat-workspace";
import { fetchModelRuntime } from "@/src/lib/ollama";
import { createConversation, SELECTED_KEY, SIDEBAR_STATE_KEY, STORAGE_KEY } from "@/src/lib/chat";
import type { CompactionPayload, Conversation, ConversationStep, ToolDefinition } from "@/src/types/chat";

const { mockSend, mockStartStream } = vi.hoisted(() => ({
  mockSend: vi.fn(() => true),
  mockStartStream: vi.fn(),
}));

vi.mock("@/src/lib/use-websocket", () => ({
  useWebSocket: () => ({ send: mockSend, connected: true, lastMessage: null }),
}));

vi.mock("@/src/lib/backend-client", () => ({
  BackendClient: vi.fn().mockImplementation(function () {
    return {
      handleServerMessage: vi.fn(),
      startStream: mockStartStream,
      cancelAll: vi.fn(),
      connectionClosed: vi.fn(),
      tokenize: vi.fn(),
    };
  }),
  WS_URL: "ws://localhost:3001",
}));

vi.mock("@/src/lib/ollama", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/ollama")>();
  return {
    ...actual,
    fetchModels: vi.fn().mockResolvedValue([]),
    fetchAllModels: vi.fn().mockResolvedValue([
      { name: "qwen3:latest", provider: "ollama", providerName: "Ollama", family: "qwen" },
    ]),
    fetchTools: vi.fn().mockResolvedValue([]),
    fetchModelMeta: vi.fn().mockResolvedValue({ name: "qwen3:latest" }),
    fetchModelRuntime: vi.fn(),
    fetchModelMetaIfAvailable: vi.fn().mockResolvedValue(undefined),
  };
});

const now = new Date().toISOString();
const COMPACT_TOOL: ToolDefinition = { id: "compact-context", name: "compact_context", description: "d", inputSchema: "{}" };
const SEARCH_TOOL: ToolDefinition = { id: "web-search", name: "web_search", description: "d", inputSchema: "{}" };
const PAYLOAD: CompactionPayload = { toolCallStepId: "tc-1", summary: "SUMMARY-TEXT", remainingWork: "REMAINING-TEXT" };

function doneSteps(): ConversationStep[] {
  return [
    { id: "tc-1", kind: "tool_call", title: "Tool Call", content: "", createdAt: now, toolCall: { id: "call-1", name: "compact_context", arguments: { summary: "SUMMARY-TEXT" } } },
  ];
}

const ORIGINAL_ID = "original-conversation";

function seedOriginal(): Conversation {
  const base = createConversation("qwen3:latest", [COMPACT_TOOL, SEARCH_TOOL], "ollama");
  const original: Conversation = {
    ...base,
    id: ORIGINAL_ID,
    title: "Research notes",
    titleEdited: true,
    systemPrompt: "be terse",
    temperature: 0.3,
    maxOutputTokens: 777,
    maxModelInvocations: 4,
    maxToolCalls: 5,
    activeToolIds: [COMPACT_TOOL.id, SEARCH_TOOL.id],
    steps: [
      { ...base.steps[0], content: "be terse" },
      { id: "u1", kind: "user", title: "User", content: "start", createdAt: now, expanded: true },
      { id: "a1", kind: "assistant", title: "Assistant", content: "ok", createdAt: now, expanded: true, usage: { inputTokens: 100, outputTokens: 20 } },
      { id: "u2", kind: "user", title: "User", content: "compact now", createdAt: now, expanded: true },
    ],
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([original]));
  window.localStorage.setItem(SELECTED_KEY, original.id);
  window.localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify({ showContextMeter: true }));
  return original;
}

const stored = (): Conversation[] => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
const storedFork = () => stored().find((conversation) => conversation.id !== ORIGINAL_ID);

interface SentRequest {
  conversationId: string;
  steps: ConversationStep[];
  tools: ToolDefinition[];
  contextWindow?: number;
  contextWindowSource?: string;
  modelFamily?: string;
  maxModelInvocations?: number;
  onCompaction?: (payload: CompactionPayload) => void;
}

const requests = () => mockStartStream.mock.calls.map((call) => call[1] as SentRequest);

/** First stream ends in a compaction (payload delivered before the promise resolves); later ones answer. */
function scriptCompactionThenAnswers() {
  mockStartStream.mockReset();
  mockStartStream.mockImplementationOnce((_send: unknown, request: SentRequest) => {
    request.onCompaction?.(PAYLOAD);
    return { promise: Promise.resolve(doneSteps()), stop: vi.fn() };
  });
  mockStartStream.mockImplementation(() => ({
    promise: Promise.resolve([{ id: "fork-answer", kind: "assistant", title: "Assistant", content: "continuing", createdAt: now, model: "qwen3:latest" }]),
    stop: vi.fn(),
  }));
}

function renderWorkspace() {
  return render(
    <ThemeRegistry>
      <ChatWorkspace />
    </ThemeRegistry>
  );
}

async function sendPrompt(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(await screen.findByRole("textbox", { name: "User Prompt" }), text);
  await user.keyboard("{Enter}");
}

describe("ChatWorkspace fork on compaction", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("ollamable.tourCompleted", "true");
    vi.mocked(fetchModelRuntime).mockReset();
    vi.mocked(fetchModelRuntime).mockResolvedValue({ loaded: true, metadata: true, contextLength: 10000 });
    Element.prototype.scrollIntoView = vi.fn();
  });

  async function compactFromOriginal() {
    const user = userEvent.setup();
    const original = seedOriginal();
    scriptCompactionThenAnswers();
    renderWorkspace();
    // The window is resolved (meter shows a percentage) before the first send, as in real use.
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveTextContent("%"));
    await sendPrompt(user, "go on");
    // The fork exists and is selected once the original's turn is over; nothing is sent for it.
    await waitFor(() => expect(stored()).toHaveLength(2));
    await waitFor(() => expect(window.localStorage.getItem(SELECTED_KEY)).toBe(storedFork()!.id));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "User Prompt" })).toBeEnabled());
    return { user, original };
  }

  it("AC-FORK-1/2/3: creates exactly one fork with the original's settings, system steps and one compaction step", async () => {
    const { original } = await compactFromOriginal();
    await waitFor(() => expect(stored()).toHaveLength(2));
    const fork = storedFork()!;

    expect(fork.forkedFrom).toEqual({ conversationId: ORIGINAL_ID, stepId: "tc-1" });
    expect(fork.title).toBe("Research notes (compacted)");
    expect(fork.titleEdited).toBe(true);
    for (const key of ["model", "provider", "systemPrompt", "temperature", "maxOutputTokens", "reasoningEffort", "maxModelInvocations", "maxToolCalls", "availableTools", "activeToolIds"] as const) {
      expect(fork[key], key).toEqual(original[key]);
    }
    expect(fork.id).not.toBe(original.id);

    const beforeResponse = fork.steps.slice(0, 2);
    expect(beforeResponse.map((s) => s.kind)).toEqual(["system", "compaction"]);
    expect(beforeResponse[0]).toEqual(original.steps[0]);
    expect(beforeResponse[1].content).toContain("SUMMARY-TEXT");
    expect(beforeResponse[1].content).toContain("REMAINING-TEXT");
    expect(beforeResponse[1].model).toBe("qwen3:latest");
    // Exactly one fork, however many renders happened.
    expect(stored().filter((c) => c.forkedFrom)).toHaveLength(1);
  });

  it("AC-FORK-4: the original gains exactly the chat.done steps and an updatedAt; the back-link target survives", async () => {
    const { original } = await compactFromOriginal();
    await waitFor(() => expect(stored()).toHaveLength(2));
    const after = stored().find((c) => c.id === ORIGINAL_ID)!;

    // Before the request: the original's steps plus the user turn that was sent.
    const sentSteps = requests()[0].steps;
    expect(sentSteps.slice(0, original.steps.length)).toEqual(original.steps);
    expect(sentSteps).toHaveLength(original.steps.length + 1);
    expect(after.steps.slice(0, sentSteps.length)).toEqual(sentSteps);
    // The request's chat.done steps (the authentic call only), then exactly one harness step naming the fork.
    const added = after.steps.slice(sentSteps.length);
    expect(added.map(({ kind }) => kind)).toEqual(["tool_call", "meta"]);
    expect(added[0].id).toBe("tc-1");
    expect(added[1].metaEvent).toMatchObject({ kind: "compaction", data: { forkConversationId: storedFork()!.id } });
    expect(added[1].content).toBe("Context compacted by the app \u2014 continued in \u201cResearch notes (compacted)\u201d");
    // The compaction target still identifies a stored step of the original.
    expect(after.steps.some((s) => s.id === storedFork()!.forkedFrom!.stepId && s.kind === "tool_call")).toBe(true);

    // Nothing else changed; the only addition is the record of the request the original really made.
    expect({ ...after, steps: [], updatedAt: "", requestContexts: undefined }).toEqual({
      ...original,
      steps: [],
      updatedAt: "",
      requestContexts: undefined,
    });
    expect(after.requestContexts).toHaveLength(1);
  });

  it("AC-FORK-13: the original renders the harness step as an event card linking to the fork; the link selects it", async () => {
    const { user } = await compactFromOriginal();
    const forkId = (await waitFor(() => { expect(stored()).toHaveLength(2); return storedFork()!; })).id;
    // Back on the original (the fork is selected after compaction).
    await user.click(await screen.findByTestId("fork-origin-link"));
    await waitFor(() => expect(window.localStorage.getItem(SELECTED_KEY)).toBe(ORIGINAL_ID));

    const event = await screen.findByTestId("compaction-harness-event");
    expect(event).toHaveTextContent("Context compacted by the app");
    expect(event).toHaveTextContent("Research notes (compacted)");
    const card = event.closest("[data-step-kind]") as HTMLElement;
    expect(card.getAttribute("data-step-kind")).toBe("meta");
    expect(document.querySelectorAll('[data-step-kind="assistant"]')).toHaveLength(1); // only the real "ok" answer
    // The raw id is not shown, and the compaction call itself is not an extra assistant message.
    expect(card).not.toHaveTextContent(forkId);

    await user.click(screen.getByTestId("compaction-fork-link"));
    await waitFor(() => expect(window.localStorage.getItem(SELECTED_KEY)).toBe(forkId));
  });

  it("AC-FORK-5/6: selects the fork and sends nothing for it until the user writes", async () => {
    await compactFromOriginal();
    expect(mockStartStream).toHaveBeenCalledTimes(1);
    expect(requests()[0].conversationId).toBe(ORIGINAL_ID);
    expect(storedFork()!.steps.map((s) => s.kind)).toEqual(["system", "compaction"]);
    // Still nothing a moment later (no deferred auto-send).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockStartStream).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("AC-FORK-7: the user's first message in the fork is a normal send with the fork's steps, tools and own context", async () => {
    const { user } = await compactFromOriginal();
    const forkId = storedFork()!.id;
    mockStartStream.mockImplementation(() => ({
      promise: Promise.resolve([{ id: "fork-answer", kind: "assistant", title: "Assistant", content: "continuing", createdAt: now, model: "qwen3:latest" }]),
      stop: vi.fn(),
    }));
    await sendPrompt(user, "and then?");
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(2));
    const second = requests()[1];
    expect(second.conversationId).toBe(forkId);
    expect(second.steps.map((s) => s.kind)).toEqual(["system", "compaction", "user"]);
    // compact_context stays available in the fork (no re-compaction guard).
    expect(second.tools.map((t) => t.name)).toEqual(["compact_context", "web_search"]);
    // The fork's own request context, resolved for the selected fork like any send.
    expect(second).toMatchObject({ contextWindow: 10000, contextWindowSource: "runtime", modelFamily: "qwen" });
    await waitFor(() => expect(storedFork()?.requestContexts).toHaveLength(1));
    expect(storedFork()!.requestContexts![0]).toMatchObject({ startIndex: 3, compactEnabled: true });
    // The title survives the first user send (AC-FORK-2).
    await waitFor(() => expect(storedFork()!.steps.some((s) => s.content === "and then?")).toBe(true));
    expect(storedFork()!.title).toBe("Research notes (compacted)");
  });

  it("AC-FORK-8: renders the compaction as a card (not an assistant message) with a working back-link", async () => {
    const { user } = await compactFromOriginal();
    const card = await waitFor(() => {
      const el = document.querySelector('[data-step-kind="compaction"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(card).toHaveTextContent("qwen3:latest");
    expect(card).toHaveTextContent("compact_context");
    expect(card).toHaveTextContent("SUMMARY-TEXT");
    expect(card.getAttribute("data-step-kind")).not.toBe("assistant");
    // The fork has no assistant message at all: nothing was sent for it.
    expect(document.querySelectorAll('[data-step-kind="assistant"]')).toHaveLength(0);
    expect(within(card).getAllByText(/SUMMARY-TEXT/).length).toBeGreaterThan(0);
    // A compaction-only fork has no use for the example prompts.
    expect(screen.queryByTestId("system-prompt-examples")).toBeNull();

    await user.click(screen.getByTestId("fork-origin-link"));
    await waitFor(() => expect(window.localStorage.getItem(SELECTED_KEY)).toBe(ORIGINAL_ID));
    expect(screen.queryByTestId("fork-origin-link")).toBeNull();
  });
});

describe("ChatWorkspace compaction that must not fork", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("ollamable.tourCompleted", "true");
    vi.mocked(fetchModelRuntime).mockResolvedValue({ loaded: true, metadata: true, contextLength: 10000 });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("does not fork when the stream is stopped after the payload was delivered", async () => {
    const user = userEvent.setup();
    seedOriginal();
    mockStartStream.mockReset();
    mockStartStream.mockImplementationOnce((_send: unknown, request: SentRequest) => {
      request.onCompaction?.(PAYLOAD);
      return { promise: Promise.reject(new Error("AbortError")), stop: vi.fn() };
    });
    renderWorkspace();
    await sendPrompt(user, "go on");
    await screen.findByText("Generation stopped.");
    expect(mockStartStream).toHaveBeenCalledTimes(1);
    expect(stored()).toHaveLength(1);
    expect(stored()[0].steps.some((s) => s.id === "tc-1")).toBe(false);
  });
});

describe("ChatWorkspace compaction harness card without its fork (AC-FORK-13)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("ollamable.tourCompleted", "true");
    Element.prototype.scrollIntoView = vi.fn();
  });

  function seedWithHarness(data: Record<string, unknown> | undefined) {
    const original = seedOriginal();
    original.steps.push({
      id: "harness-1", kind: "meta", title: "Context compacted", content: "Context compacted by the app \u2014 continued in \u201cGone fork\u201d",
      createdAt: now, expanded: true,
      metaEvent: { kind: "compaction", title: "Context compacted", detail: "d", data },
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([original]));
  }

  it.each([
    ["the fork was deleted", { forkConversationId: "no-such-conversation" }],
    ["the id is malformed", { forkConversationId: 42 }],
    ["there is no data", undefined],
  ])("renders without a link when %s", async (_name, data) => {
    seedWithHarness(data);
    renderWorkspace();
    await waitFor(() => expect(document.querySelector('[data-step-kind="meta"]')).not.toBeNull());
    expect(screen.queryByTestId("compaction-fork-link")).toBeNull();
    expect(document.body).toHaveTextContent("Gone fork");
  });
});
