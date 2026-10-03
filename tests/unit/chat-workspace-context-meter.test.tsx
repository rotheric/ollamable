/**
 * Context meter wired through the real ChatWorkspace tree (epic-compaction-tool S2):
 * AC-UX-1..7. Only the network edges (`fetchModelRuntime`, `fetchModelMetaIfAvailable`,
 * discovery) and the websocket/backend client are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeRegistry } from "@/src/components/theme-registry";
import { ChatWorkspace } from "@/src/components/chat-workspace";
import { fetchModelMetaIfAvailable, fetchModelRuntime, fetchTools } from "@/src/lib/ollama";
import { createConversation, SELECTED_KEY, SIDEBAR_STATE_KEY, STORAGE_KEY } from "@/src/lib/chat";
import { modelIdentity } from "@/src/lib/model-identity";

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

const runtimeMock = vi.mocked(fetchModelRuntime);
const metaMock = vi.mocked(fetchModelMetaIfAvailable);
const now = new Date().toISOString();

function step(kind: string, usage?: { inputTokens: number; outputTokens: number }) {
  return { id: `${kind}-${Math.random()}`, kind, title: kind, content: kind === "system" ? "" : "text", createdAt: now, expanded: true, ...(usage ? { usage } : {}) };
}

function seed(steps: Array<Record<string, unknown>>, sidebar: Record<string, unknown> = { showContextMeter: true }) {
  const conversation = { ...createConversation("qwen3:latest", [], "ollama"), steps: [step("system"), step("user"), ...steps] };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([conversation]));
  window.localStorage.setItem(SELECTED_KEY, conversation.id);
  window.localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(sidebar));
}

function renderWorkspace() {
  return render(
    <ThemeRegistry>
      <ChatWorkspace />
    </ThemeRegistry>
  );
}

const meterText = () => screen.findByTestId("context-meter");

describe("ChatWorkspace context meter", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("ollamable.tourCompleted", "true");
    mockStartStream.mockReset();
    runtimeMock.mockReset();
    metaMock.mockReset();
    metaMock.mockResolvedValue(undefined);
    runtimeMock.mockResolvedValue({ loaded: true, metadata: true, contextLength: 10000 });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders no meter and makes no runtime request while showContextMeter is false (AC-UX-1)", async () => {
    seed([step("assistant", { inputTokens: 100, outputTokens: 20 })], { showContextMeter: false });
    renderWorkspace();
    await screen.findByRole("textbox", { name: "User Prompt" });
    expect(screen.queryByTestId("context-meter")).toBeNull();
    expect(runtimeMock).not.toHaveBeenCalled();
  });

  it("is off by default when no preference was ever stored (AC-UX-1)", async () => {
    seed([step("assistant", { inputTokens: 100, outputTokens: 20 })], {});
    renderWorkspace();
    await screen.findByRole("textbox", { name: "User Prompt" });
    expect(screen.queryByTestId("context-meter")).toBeNull();
  });

  it("shows grouped tokens and the percentage from the last invocation's usage (AC-UX-2)", async () => {
    seed([step("assistant", { inputTokens: 100, outputTokens: 20 }), step("user"), step("assistant", { inputTokens: 6000, outputTokens: 120 })]);
    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveTextContent("6,120 tokens · 61%"));
    expect(screen.getByTestId("context-meter")).toHaveAttribute("data-level", "ok");
  });

  it("shows 0 tokens and 0% when the conversation has no response yet (AC-UX-2)", async () => {
    seed([]);
    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveTextContent("0 tokens · 0%"));
  });

  it("shows an em dash when a response carried no usage (AC-UX-3)", async () => {
    seed([step("assistant")]);
    renderWorkspace();
    await waitFor(() => expect(runtimeMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveTextContent("—"));
    expect(screen.getByTestId("context-meter")).not.toHaveAttribute("data-level");
  });

  it("shows an em dash when the latest response carried no usage even though an older one did (AC-UX-3)", async () => {
    seed([step("assistant", { inputTokens: 100, outputTokens: 20 }), step("user"), step("assistant")]);
    renderWorkspace();
    await waitFor(() => expect(runtimeMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveTextContent("—"));
  });

  it("keeps the previous completed value while a response is streaming, instead of flipping to an em dash", async () => {
    const user = userEvent.setup();
    seed([step("assistant", { inputTokens: 100, outputTokens: 20 })]);
    mockStartStream.mockImplementation((_send: unknown, request: { onDelta: (steps: unknown[]) => void }) => {
      // A partial response without usage: it becomes an in-flight (stream-) step in the conversation.
      request.onDelta([step("assistant")]);
      return { promise: new Promise(() => undefined), stop: vi.fn() };
    });
    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveTextContent("120 tokens"));

    await user.type(screen.getByRole("textbox", { name: "User Prompt" }), "next");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mockStartStream).toHaveBeenCalled());
    await screen.findByText("next");
    expect(screen.getByTestId("context-meter")).toHaveTextContent("120 tokens");
    expect(screen.getByTestId("context-meter")).not.toHaveTextContent("—");
  });

  it("updates the fill after chat.done and re-queries /models/runtime without a reload (AC-UX-4)", async () => {
    const user = userEvent.setup();
    seed([step("assistant", { inputTokens: 100, outputTokens: 20 })]);
    runtimeMock
      .mockResolvedValueOnce({ loaded: true, metadata: true, contextLength: 10000 })
      .mockResolvedValue({ loaded: true, metadata: true, contextLength: 4000 });
    mockStartStream.mockReturnValue({
      promise: Promise.resolve([step("assistant", { inputTokens: 3000, outputTokens: 400 })]),
      stop: vi.fn(),
    });
    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveTextContent("120 tokens · 1%"));
    expect(runtimeMock).toHaveBeenCalledTimes(1);

    await user.type(screen.getByRole("textbox", { name: "User Prompt" }), "next");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(runtimeMock).toHaveBeenCalledTimes(2));
    // 3,400 of the re-queried 4,000 window: the new fill against the new window.
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveTextContent("3,400 tokens · 85%"));
    expect(screen.getByTestId("context-meter")).toHaveAttribute("data-level", "warn");
  });

  it.each([
    [7900, "ok"],
    [8000, "warn"],
    [9999, "warn"],
    [10000, "error"],
    [12000, "error"],
  ])("sets data-level from a fill of %i of 10000 (AC-UX-5)", async (used, level) => {
    seed([step("assistant", { inputTokens: used, outputTokens: 0 })]);
    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveAttribute("data-level", level));
  });

  it("keeps showContextMeter across a reload once toggled in settings (AC-UX-6)", async () => {
    const user = userEvent.setup();
    seed([], {});
    const first = renderWorkspace();
    await screen.findByRole("textbox", { name: "User Prompt" });
    expect(screen.queryByTestId("context-meter")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand tools sidebar" }));
    await user.click(screen.getByRole("button", { name: "Client" }));
    await user.click(screen.getByRole("checkbox", { name: "Show context meter" }));
    await meterText();
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_STATE_KEY)!).showContextMeter).toBe(true);

    first.unmount();
    renderWorkspace();
    await meterText();
  });

  it("labels an assumed window and skips /models/show for a runtime without metadata (AC-UX-7)", async () => {
    seed([step("assistant", { inputTokens: 10, outputTokens: 0 })]);
    runtimeMock.mockResolvedValue({ loaded: false, metadata: false });
    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("context-meter-source")).toHaveTextContent("assumed"));
    expect(metaMock).toHaveBeenCalledWith(expect.objectContaining({ name: "qwen3:latest" }), { loaded: false, metadata: false });
  });

  it("labels an estimated window from model metadata (AC-UX-7)", async () => {
    seed([step("assistant", { inputTokens: 10, outputTokens: 0 })]);
    runtimeMock.mockResolvedValue({ loaded: false, metadata: true });
    metaMock.mockResolvedValue({ name: "qwen3:latest", modelInfo: { "general.architecture": "qwen3", "qwen3.context_length": 40960 } });
    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("context-meter-source")).toHaveTextContent("estimated"));
  });

  it("remembers a live window and labels it stale once the model is unloaded (AC-UX-7, AC-CTX-1 caller obligation)", async () => {
    seed([step("assistant", { inputTokens: 10, outputTokens: 0 })]);
    const first = renderWorkspace();
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(SIDEBAR_STATE_KEY)!);
      expect(stored.rememberedContextWindows[modelIdentity("ollama", "qwen3:latest")]).toBe(10000);
    });
    expect(screen.queryByTestId("context-meter-source")).toBeNull();
    first.unmount();

    runtimeMock.mockResolvedValue({ loaded: false, metadata: true });
    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("context-meter-source")).toHaveTextContent("stale"));
    expect(screen.getByTestId("context-meter")).toHaveTextContent("10 tokens · 0%");
  });

  it("never renders the window size (spec: not displayed)", async () => {
    seed([step("assistant", { inputTokens: 10, outputTokens: 0 })]);
    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveTextContent("10 tokens"));
    expect(screen.getByTestId("context-meter").textContent).not.toMatch(/10,?000/);
  });
});

describe("ChatWorkspace context meter for a legacy provider-less conversation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("ollamable.tourCompleted", "true");
    runtimeMock.mockReset();
    metaMock.mockReset();
    metaMock.mockResolvedValue(undefined);
    runtimeMock.mockResolvedValue({ loaded: true, metadata: true, contextLength: 10000 });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("resolves the runtime window once discovery migrates the conversation to its provider", async () => {
    const legacy = { ...createConversation("qwen3:latest", [], undefined), steps: [step("system"), step("user"), step("assistant", { inputTokens: 900, outputTokens: 100 })] };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([legacy]));
    window.localStorage.setItem(SELECTED_KEY, legacy.id);
    window.localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify({ showContextMeter: true }));
    renderWorkspace();
    await waitFor(async () => expect((await meterText()).textContent).toContain("1,000 tokens · 10%"));
    expect(runtimeMock).toHaveBeenCalledWith(expect.objectContaining({ name: "qwen3:latest", provider: "ollama" }));
    expect((await meterText()).textContent).not.toContain("assumed");
  });
});

describe("ChatWorkspace chat.send context fields (usage note)", () => {
  const compactTool = { id: "compact-context", name: "compact_context", description: "d", inputSchema: "{}" };

  function seedWithTools(tools: Array<typeof compactTool>, sidebar: Record<string, unknown>) {
    const conversation = {
      ...createConversation("qwen3:latest", tools, "ollama"),
      activeToolIds: tools.map((tool) => tool.id),
      steps: [step("system"), step("user"), step("assistant", { inputTokens: 100, outputTokens: 20 })],
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([conversation]));
    window.localStorage.setItem(SELECTED_KEY, conversation.id);
    window.localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(sidebar));
  }

  async function sendPrompt() {
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "User Prompt" }), "next");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mockStartStream).toHaveBeenCalled());
    return mockStartStream.mock.calls[0][1] as Record<string, unknown>;
  }

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("ollamable.tourCompleted", "true");
    // The backend catalog must list the tool or the conversation prunes it.
    vi.mocked(fetchTools).mockResolvedValue([compactTool]);
    mockStartStream.mockReset();
    mockStartStream.mockReturnValue({ promise: new Promise(() => undefined), stop: vi.fn() });
    runtimeMock.mockReset();
    metaMock.mockReset();
    metaMock.mockResolvedValue(undefined);
    runtimeMock.mockResolvedValue({ loaded: true, metadata: true, contextLength: 10000 });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("resolves the window and sends it with the model family while compact_context is active, even with the meter off", async () => {
    seedWithTools([compactTool], { showContextMeter: false });
    renderWorkspace();
    await waitFor(() => expect(runtimeMock).toHaveBeenCalled());
    expect(screen.queryByTestId("context-meter")).toBeNull();
    const request = await sendPrompt();
    expect(request).toMatchObject({ contextWindow: 10000, contextWindowSource: "runtime", modelFamily: "qwen" });
  });

  it("uses the same resolution as the meter when both are on (no second path)", async () => {
    seedWithTools([compactTool], { showContextMeter: true });
    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("context-meter")).toHaveTextContent("120 tokens · 1%"));
    const request = await sendPrompt();
    expect(request).toMatchObject({ contextWindow: 10000, contextWindowSource: "runtime" });
    expect(runtimeMock).toHaveBeenCalledTimes(1);
  });

  it("still sends, without a model family, for a conversation whose model discovery does not list", async () => {
    seedWithTools([compactTool], { showContextMeter: false });
    const [stored] = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...stored, model: "ghost:latest" }]));
    renderWorkspace();
    const request = await sendPrompt();
    expect(request.model).toBe("ghost:latest");
    expect(request.modelFamily).toBeUndefined();
  });

  it("fetches nothing and sends no window when neither the meter nor compact_context is on", async () => {
    seedWithTools([], { showContextMeter: false });
    renderWorkspace();
    const request = await sendPrompt();
    expect(runtimeMock).not.toHaveBeenCalled();
    expect(request.contextWindow).toBeUndefined();
    expect(request.contextWindowSource).toBeUndefined();
  });
});

afterEach(() => {
  vi.mocked(fetchTools).mockResolvedValue([]);
});
