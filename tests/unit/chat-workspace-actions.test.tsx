/**
 * ChatWorkspace actions through the real component tree: the transcript and
 * settings callbacks the composition root owns (system prompt, step
 * expansion, tool toggles, resend / regenerate / edit / delete-last-exchange,
 * stop and resume, tool navigation), the WebSocket message routing
 * (`tools.update` vs. everything else) and the dialogs it wires. Only the
 * WebSocket hook, the backend client and the HTTP catalog are mocked; every
 * assertion is on rendered UI, persisted storage or the request handed to the
 * backend client.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeRegistry } from "@/src/components/theme-registry";
import { ChatWorkspace } from "@/src/components/chat-workspace";
import { SELECTED_KEY, SIDEBAR_STATE_KEY, STORAGE_KEY } from "@/src/lib/chat";
import type { Conversation, ConversationStep, ToolDefinition } from "@/src/types/chat";

const { mockSend, mockStartStream, mockHandleServerMessage } = vi.hoisted(() => ({
  mockSend: vi.fn(() => true),
  mockStartStream: vi.fn(),
  mockHandleServerMessage: vi.fn(),
}));

vi.mock("@/src/lib/use-websocket", () => ({
  useWebSocket: (_url: string, onMessage: (data: unknown) => void) => {
    (globalThis as Record<string, unknown>).__actionsWsOnMessage = onMessage;
    return { send: mockSend, connected: true, lastMessage: null };
  },
}));

vi.mock("@/src/lib/backend-client", () => ({
  BackendClient: vi.fn().mockImplementation(function () {
    return {
      handleServerMessage: mockHandleServerMessage,
      startStream: mockStartStream,
      cancelAll: vi.fn(),
      connectionClosed: vi.fn(),
      tokenize: () => Promise.resolve({ tokens: [] as string[], tokenIds: [] as number[] }),
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
      { name: "qwen3:latest", provider: "ollama", providerName: "Ollama", family: "qwen", families: ["qwen"], parameterSize: "8B" },
    ]),
    fetchTools: vi.fn().mockResolvedValue([{ id: "web-search", name: "web_search", description: "Searches the web.", inputSchema: "{\"type\":\"object\"}" }]),
    fetchModelMeta: vi.fn().mockResolvedValue({ name: "qwen3:latest", capabilities: ["completion"] }),
    fetchModelRuntime: vi.fn().mockResolvedValue(undefined),
    fetchModelMetaIfAvailable: vi.fn().mockResolvedValue(undefined),
  };
});

const now = "2026-01-01T00:00:00.000Z";
const WEB: ToolDefinition = { id: "web-search", name: "web_search", description: "Searches the web.", inputSchema: "{\"type\":\"object\"}" };
const CURL: ToolDefinition = { id: "curl", name: "curl", description: "Fetches a URL.", inputSchema: "{\"type\":\"object\"}" };

function s(id: string, kind: ConversationStep["kind"], content: string, extra: Partial<ConversationStep> = {}): ConversationStep {
  return { id, kind, title: kind === "user" ? "User" : kind === "assistant" ? "Assistant" : "System Prompt", content, createdAt: now, expanded: true, ...extra };
}

function conversation(id: string, steps: ConversationStep[], extra: Partial<Conversation> = {}): Conversation {
  return {
    id, title: `Title ${id}`, titleEdited: false, model: "qwen3:latest", provider: "ollama", systemPrompt: "",
    createdAt: now, updatedAt: now, availableTools: [], activeToolIds: [], steps, ...extra,
  };
}

function seed(conversations: Conversation[], selected = conversations[0].id) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  window.localStorage.setItem(SELECTED_KEY, selected);
}

function stored(id: string): Conversation {
  const all = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as Conversation[];
  const found = all.find((c) => c.id === id);
  if (!found) throw new Error(`conversation ${id} not stored`);
  return found;
}

function renderWorkspace() {
  return render(
    <ThemeRegistry>
      <ChatWorkspace />
    </ThemeRegistry>
  );
}

/** A stream that stays open until stopped; its stop rejects the way BackendClient's does. */
function pendingStream(onStart?: (request: { onStableSteps: (steps: ConversationStep[]) => void }) => void) {
  mockStartStream.mockImplementationOnce((_send: unknown, request: { onStableSteps: (steps: ConversationStep[]) => void }) => {
    let reject!: (e: Error) => void;
    const promise = new Promise<ConversationStep[]>((_, rej) => { reject = rej; });
    queueMicrotask(() => onStart?.(request));
    return { promise, stop: () => reject(new Error("AbortError")) };
  });
}

const SYS = s("sys", "system", "");
const DEFAULT_REPLY = [s("reply", "assistant", "Fresh reply")];

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("ollamable.tourCompleted", "true");
  mockStartStream.mockReset();
  mockStartStream.mockImplementation(() => ({ promise: Promise.resolve(DEFAULT_REPLY), stop: vi.fn() }));
  mockHandleServerMessage.mockReset();
  mockSend.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("initial state", () => {
  it("renders no error banner before anything went wrong", async () => {
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")])]);
    renderWorkspace();
    await screen.findByText("Hello");
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });
});

describe("WebSocket message routing", () => {
  const deliver = (msg: unknown) => act(() => {
    ((globalThis as Record<string, unknown>).__actionsWsOnMessage as (d: unknown) => void)(msg);
  });

  it("merges announced MCP tools into the conversations instead of forwarding them to the backend client", async () => {
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")])]);
    renderWorkspace();
    await screen.findByText("Hello");
    const echo: ToolDefinition = { id: "mcp-srv-echo", name: "echo", description: "Echo.", inputSchema: "{}" };
    deliver({ type: "tools.update", tools: [echo] });
    await waitFor(() => expect(stored("c1").availableTools.map((t) => t.id)).toContain("mcp-srv-echo"));
    expect(mockHandleServerMessage).not.toHaveBeenCalled();
  });

  it("forwards every other message, and a tools.update without tools, to the backend client", async () => {
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")])]);
    renderWorkspace();
    await screen.findByText("Hello");
    const delta = { type: "chat.delta", conversationId: "c1", steps: [] };
    // Only the message type decides; a stray `tools` field on another message does not reroute it.
    const stray = { type: "chat.steps", conversationId: "c1", steps: [], tools: [{ id: "x", name: "x", description: "", inputSchema: "{}" }] };
    deliver(delta);
    deliver({ type: "tools.update" });
    deliver(stray);
    expect(mockHandleServerMessage.mock.calls).toEqual([[delta], [{ type: "tools.update" }], [stray]]);
    expect(stored("c1").availableTools.map((t) => t.id)).not.toContain("x");
  });
});

describe("conversation actions", () => {
  it("clears the composer draft when a new chat is created", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")])]);
    renderWorkspace();
    await screen.findByText("Hello");
    await user.type(screen.getByRole("textbox", { name: "User Prompt" }), "draft text");
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "User Prompt" })).toHaveValue(""));
  });

  it("collapsing the conversation sidebar is remembered", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")])]);
    renderWorkspace();
    await screen.findByText("Hello");
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(SIDEBAR_STATE_KEY)!).sidebarOpen).toBe(false));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("starting the tour seeds and selects its example conversations", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")])]);
    renderWorkspace();
    await screen.findByText("Hello");
    await user.click(screen.getByRole("button", { name: "Take tour" }));
    await waitFor(() => {
      const all = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!) as Array<Conversation & { _tourExample?: boolean }>;
      expect(all.some((c) => c._tourExample)).toBe(true);
      expect(all.some((c) => c.id === "c1")).toBe(true);
    });
    expect(window.localStorage.getItem(SELECTED_KEY)).not.toBe("c1");
  });
});

describe("system prompt", () => {
  it("mirrors the field into the system step and leaves the messages alone", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Hello"), s("a1", "assistant", "World")])]);
    renderWorkspace();
    await screen.findByText("World");
    await user.type(screen.getByRole("textbox", { name: "System prompt" }), "Be brief");
    await waitFor(() => expect(stored("c1").systemPrompt).toBe("Be brief"));
    expect(stored("c1").steps.map((x) => [x.id, x.content])).toEqual([["sys", "Be brief"], ["u1", "Hello"], ["a1", "World"]]);
  });
});

describe("step expansion", () => {
  it("toggles only the clicked step and persists it", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Hello"), s("a1", "assistant", "World")])]);
    const { container } = renderWorkspace();
    await screen.findByText("World");
    const card = container.querySelector<HTMLElement>('[data-step-kind="assistant"]')!;
    const header = within(card).getAllByRole("button")[0];
    await user.click(header);
    await waitFor(() => expect(stored("c1").steps.find((x) => x.id === "a1")!.expanded).toBe(false));
    expect(stored("c1").steps.find((x) => x.id === "u1")!.expanded).toBe(true);
    await user.click(header);
    await waitFor(() => expect(stored("c1").steps.find((x) => x.id === "a1")!.expanded).toBe(true));
  });

  it("expands a collapsed user message when its edit starts", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Hello", { expanded: false }), s("a1", "assistant", "World")])]);
    renderWorkspace();
    await screen.findByText("World");
    // A collapsed user message still starts editing on a double-click of its content.
    await user.dblClick(screen.getByText("Hello"));
    await waitFor(() => expect(stored("c1").steps.find((x) => x.id === "u1")!.expanded).toBe(true));
  });
});

describe("tool toggles", () => {
  async function openBuiltinTools(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Expand tools sidebar" }));
    await user.click(screen.getByRole("button", { name: "Tools" }));
    await user.click(screen.getByText("built-in"));
  }

  it("unchecking one active tool keeps the others active", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")], { availableTools: [WEB, CURL], activeToolIds: [WEB.id, CURL.id] })]);
    renderWorkspace();
    await screen.findByText("Hello");
    await openBuiltinTools(user);
    await user.click(screen.getByRole("checkbox", { name: /web_search/i }));
    await waitFor(() => expect(stored("c1").activeToolIds).toEqual([CURL.id]));
  });

  it("'disable all' deactivates every tool", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")], { availableTools: [WEB, CURL], activeToolIds: [WEB.id, CURL.id] })]);
    renderWorkspace();
    await screen.findByText("Hello");
    await openBuiltinTools(user);
    await user.click(screen.getByText("disable all"));
    await waitFor(() => expect(stored("c1").activeToolIds).toEqual([]));
  });

  it("clicking an active tool in the transcript reveals and scrolls to its settings card", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")], { availableTools: [WEB], activeToolIds: [WEB.id] })]);
    renderWorkspace();
    await screen.findByText("Hello");
    const transcriptToolName = screen.getAllByText("web_search").find((el) => !el.closest("[data-tool-id]"))!;
    await user.click(transcriptToolName);
    await waitFor(() => {
      const call = scrollIntoView.mock.contexts.findIndex((el) => (el as HTMLElement).getAttribute?.("data-tool-id") === WEB.id);
      expect(call).toBeGreaterThanOrEqual(0);
      expect(scrollIntoView.mock.calls[call][0]).toEqual({ behavior: "smooth", block: "center" });
    }, { timeout: 2000 });
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_STATE_KEY)!).rightSidebarOpen).toBe(true);
  });
});

describe("sending", () => {
  it("sends the trimmed prompt as a 'User' step and titles an untitled conversation from it", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS], { title: "New conversation" })]);
    renderWorkspace();
    await screen.findByRole("textbox", { name: "User Prompt" });
    await user.type(screen.getByRole("textbox", { name: "User Prompt" }), "   Plan a trip   ");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledOnce());
    const request = mockStartStream.mock.calls[0][1] as { steps: ConversationStep[] };
    expect(request.steps.at(-1)).toMatchObject({ kind: "user", title: "User", content: "Plan a trip" });
    await waitFor(() => expect(stored("c1").title).toBe("Plan a trip"));
  });

  it("keeps a title the user edited", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS], { title: "My title", titleEdited: true })]);
    renderWorkspace();
    await screen.findByRole("textbox", { name: "User Prompt" });
    await user.type(screen.getByRole("textbox", { name: "User Prompt" }), "Plan a trip");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(stored("c1").steps.at(-1)!.content).toBe("Fresh reply"));
    expect(stored("c1").title).toBe("My title");
  });
});

describe("transcript edits", () => {
  const HISTORY = () => [
    SYS,
    s("u1", "user", "First question"),
    s("a1", "assistant", "First answer"),
    s("u2", "user", "Second question"),
    s("a2", "assistant", "Second answer"),
  ];

  it("resending an earlier user message requests the history up to and including it, without retitling", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", HISTORY(), { title: "Kept title" })]);
    renderWorkspace();
    await screen.findByText("Second answer");
    await user.click(screen.getAllByRole("button", { name: "Resend message" })[0]);
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledOnce());
    const request = mockStartStream.mock.calls[0][1] as { steps: ConversationStep[] };
    expect(request.steps.map((x) => x.id)).toEqual(["sys", "u1"]);
    await waitFor(() => expect(stored("c1").steps.map((x) => x.id)).toEqual(["sys", "u1", "reply"]));
    expect(stored("c1").title).toBe("Kept title");
  });

  it("regenerating an answer does not retitle the conversation", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", HISTORY(), { title: "Kept title" })]);
    renderWorkspace();
    await screen.findByText("Second answer");
    await user.click(screen.getAllByRole("button", { name: "Regenerate response" })[0]);
    await waitFor(() => expect(stored("c1").steps.map((x) => x.id)).toEqual(["sys", "u1", "reply"]));
    expect(stored("c1").title).toBe("Kept title");
  });

  it("editing the first user message retitles the conversation and keeps the edited message expanded", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", HISTORY(), { title: "First question" })]);
    renderWorkspace();
    await screen.findByText("Second answer");
    await user.click(screen.getAllByRole("button", { name: "Edit message" })[0]);
    const input = screen.getByRole("textbox", { name: "Edit message" });
    await user.clear(input);
    await user.type(input, "Rewritten question");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(stored("c1").steps.map((x) => x.id)).toEqual(["sys", "u1", "reply"]));
    expect(stored("c1").steps[1]).toMatchObject({ content: "Rewritten question", expanded: true });
    expect(stored("c1").title).toBe("Rewritten question");
  });

  it("deleting a lone first message leaves just the system prompt", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Only question")])]);
    renderWorkspace();
    await screen.findByText("Only question");
    await user.click(screen.getByRole("button", { name: "Delete message" }));
    await waitFor(() => expect(stored("c1").steps.map((x) => x.id)).toEqual(["sys"]));
    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it("deleting the last answer keeps the question that prompted it and everything before", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", HISTORY())]);
    renderWorkspace();
    await screen.findByText("Second answer");
    await user.click(screen.getByRole("button", { name: "Delete message" }));
    await waitFor(() => expect(stored("c1").steps.map((x) => x.id)).toEqual(["sys", "u1", "a1", "u2"]));
  });
});

describe("stop and resume", () => {
  async function sendAndStop(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByRole("textbox", { name: "User Prompt" }), "Long task");
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("button", { name: "Stop" }));
  }

  it("offers Resume after a stop and resumes from the kept steps", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS])]);
    pendingStream();
    renderWorkspace();
    await screen.findByRole("textbox", { name: "User Prompt" });
    await sendAndStop(user);
    await user.click(await screen.findByRole("button", { name: "Resume generation" }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(2));
    const resumed = mockStartStream.mock.calls[1][1] as { steps: ConversationStep[] };
    expect(resumed.steps.map((x) => x.kind)).toEqual(["system", "user"]);
    expect(resumed.steps[1].content).toBe("Long task");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resume generation" })).not.toBeInTheDocument());
  });

  it("does not offer Resume on another conversation", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS]), conversation("c2", [SYS, s("u9", "user", "Other chat question")], { title: "Other chat" })]);
    pendingStream();
    renderWorkspace();
    await screen.findByRole("textbox", { name: "User Prompt" });
    await sendAndStop(user);
    await screen.findByRole("button", { name: "Resume generation" });
    await user.click(screen.getByText("Other chat"));
    await screen.findByText("Other chat question");
    expect(screen.queryByRole("button", { name: "Resume generation" })).not.toBeInTheDocument();
  });

  it("does not offer Resume when the stopped turn already ended with an answer", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS])]);
    pendingStream((request) => request.onStableSteps([s("kept", "assistant", "Kept answer")]));
    renderWorkspace();
    await screen.findByRole("textbox", { name: "User Prompt" });
    await sendAndStop(user);
    await screen.findByText("Generation stopped.");
    expect(screen.getByText("Kept answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume generation" })).not.toBeInTheDocument();
  });
});

describe("stopped conversation removal", () => {
  it("keeps working after the stopped conversation was the only one and is deleted", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS], { title: "Doomed chat" })]);
    pendingStream();
    renderWorkspace();
    await screen.findByRole("textbox", { name: "User Prompt" });
    await user.type(screen.getByRole("textbox", { name: "User Prompt" }), "Long task");
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    await screen.findByRole("button", { name: "Resume generation" });
    await user.click(screen.getByRole("button", { name: /Delete conversation/ }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "User Prompt" })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume generation" })).not.toBeInTheDocument();
  });
});

describe("dialogs", () => {
  it("titles the model metadata dialog with the selected model", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")])]);
    renderWorkspace();
    await screen.findByText("Hello");
    await user.click(await screen.findByRole("button", { name: "Open model settings for qwen3:latest" }));
    await user.click(await screen.findByRole("button", { name: "Model info" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("qwen3:latest")).toBeInTheDocument();
    expect(within(dialog).queryByText("Model metadata")).not.toBeInTheDocument();
  });

  it("closes the request JSON dialog", async () => {
    const user = userEvent.setup();
    seed([conversation("c1", [SYS, s("u1", "user", "Hello")])]);
    renderWorkspace();
    await screen.findByText("Hello");
    await user.click(screen.getByRole("button", { name: "View request JSON" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
