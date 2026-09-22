import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeRegistry } from "@/src/components/theme-registry";
import { ChatWorkspace } from "@/src/components/chat-workspace";
import { fetchModelMeta } from "@/src/lib/ollama";
import { SELECTED_KEY, STORAGE_KEY } from "@/src/lib/chat";

const { mockSend, mockStartStream, mockCancelAll } = vi.hoisted(() => ({
  mockSend: vi.fn(() => true),
  mockStartStream: vi.fn(),
  mockCancelAll: vi.fn(),
}));
// Plain functions, not vi.fn() (unlike chat-workspace-token-view.test.tsx,
// which does assert on these): this file never asserts on
// cancelPendingTokenize/tokenize, they only need to exist so the mock
// satisfies the real BackendClient shape (S3-R4) without throwing. Kept as
// non-vi.fn() to avoid adding new `vi` reference sites in a file that
// (pre-existing, unrelated to this fix) has no explicit `import { vi } from
// "vitest"` and so has no static type for the global.
const mockCancelPendingTokenize = () => {};
const mockTokenize = () => Promise.resolve({ tokens: [] as string[], tokenIds: [] as number[] });

vi.mock("@/src/lib/use-websocket", () => ({
  // Arity-3 (S3-R4): the real contract (src/lib/use-websocket.ts) takes an
  // `onClose` third argument that chat-workspace.tsx wires to
  // `BackendClient.cancelPendingTokenize()` (S3-R1).
  useWebSocket: (_url: string, onMessage: (data: unknown) => void, onClose?: () => void) => {
    (globalThis as Record<string, unknown>).__wsMockOnMessage = onMessage;
    (globalThis as Record<string, unknown>).__wsMockOnClose = onClose;
    return { send: mockSend, connected: true, lastMessage: null };
  },
}));

vi.mock("@/src/lib/backend-client", () => ({
  BackendClient: vi.fn().mockImplementation(() => ({
    handleServerMessage: vi.fn(),
    startStream: mockStartStream,
    cancelAll: mockCancelAll,
    cancelPendingTokenize: mockCancelPendingTokenize,
    tokenize: mockTokenize,
  })),
  WS_URL: "ws://localhost:3001",
}));

vi.mock("@/src/lib/ollama", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/ollama")>();

  return {
    ...actual,
    fetchModels: vi.fn().mockResolvedValue([
      {
        name: "qwen3:latest",
        family: "qwen",
        families: ["qwen"],
        parameterSize: "8B",
      },
      {
        name: "nomic-embed-text:latest",
        family: "bert",
        families: ["bert"],
        parameterSize: "768D",
      },
    ]),
    fetchAllModels: vi.fn().mockResolvedValue([
      {
        name: "qwen3:latest",
        provider: "ollama",
        providerName: "Ollama",
        family: "qwen",
        families: ["qwen"],
        parameterSize: "8B",
      },
      {
        name: "nomic-embed-text:latest",
        provider: "ollama",
        providerName: "Ollama",
        family: "bert",
        families: ["bert"],
        parameterSize: "768D",
      },
    ]),
    fetchModelMeta: vi.fn().mockResolvedValue({
      name: "qwen3:latest",
      family: "qwen",
      families: ["qwen"],
      parameterSize: "8B",
      format: "gguf",
      quantizationLevel: "Q4_K_M",
      capabilities: ["completion"],
      parameters: "temperature 0.7",
      modelInfo: {
        "general.architecture": "qwen3",
      },
    }),
    fetchTools: vi.fn().mockResolvedValue([
      {
        id: "web-search",
        name: "web_search",
        description: "Searches the web using Brave Search and returns relevant results.",
        inputSchema: JSON.stringify({
          type: "object",
          properties: { query: { type: "string" }, count: { type: "number" } },
          required: ["query"],
        }),
      },
    ]),
  };
});

const mockedFetchModelMeta = vi.mocked(fetchModelMeta);

const defaultResponseSteps = [
  {
    id: "assistant-1",
    kind: "assistant" as const,
    title: "Assistant",
    content: "Streamed answer",
    createdAt: new Date().toISOString(),
    expanded: true,
  },
];

function setupStartStream(steps = defaultResponseSteps) {
  mockStartStream.mockReturnValue({
    promise: Promise.resolve(steps),
    stop: vi.fn(),
  });
}

describe("ChatWorkspace", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Prevent the guided tour from auto-starting and switching conversations mid-test
    window.localStorage.setItem("ollamable.tourCompleted", "true");
    mockStartStream.mockClear();
    mockSend.mockClear();
    mockCancelAll.mockClear();
    setupStartStream();
    mockedFetchModelMeta.mockClear();
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  function renderWorkspace() {
    return render(
      <ThemeRegistry>
        <ChatWorkspace />
      </ThemeRegistry>
    );
  }

  it("renders the seeded conversation with the tools sidebar collapsed by default", async () => {
    renderWorkspace();

    expect(await screen.findAllByText("qwen3:latest")).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "Expand tools sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mode$/i })).toBeInTheDocument();
  });

  it("allows creating a new conversation", async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace();

    await screen.findAllByText("qwen3:latest");
    const button = container.querySelector('button[aria-label="New chat"]');

    expect(button).not.toBeNull();
    await user.click(button!);

    await waitFor(() => {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toHaveLength(2);
    });
  });

  it("filters embedding models out of the selector", async () => {
    renderWorkspace();

    expect(await screen.findAllByText("qwen3:latest")).not.toHaveLength(0);
    expect(screen.queryByText("nomic-embed-text:latest")).not.toBeInTheDocument();
  });

  it("opens a model metadata dialog when clicking the model chip", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole("button", { name: "Open metadata for qwen3:latest" }));

    expect(mockedFetchModelMeta).toHaveBeenCalledWith(
      expect.objectContaining({ name: "qwen3:latest" })
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    expect(screen.getByText("completion")).toBeInTheDocument();
    expect(screen.getByText("temperature 0.7")).toBeInTheDocument();
  });

  it("allows editing the selected conversation title", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "conversation-1",
          title: "Test chat",
          titleEdited: false,
          model: "qwen3:latest",
          systemPrompt: "",
          createdAt: now,
          updatedAt: now,
          steps: [
            { id: "system-1", kind: "system", title: "System Prompt", content: "", createdAt: now, expanded: true },
            { id: "user-1", kind: "user", title: "User", content: "Hello", createdAt: now, expanded: true },
          ],
        },
      ])
    );
    window.localStorage.setItem(SELECTED_KEY, "conversation-1");

    renderWorkspace();

    await screen.findByText("Test chat");
    await user.click(screen.getByText("Test chat"));

    const titleInput = screen.getByDisplayValue("Test chat");
    await user.clear(titleInput);
    await user.type(titleInput, "Renamed conversation");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getAllByText("Renamed conversation")).not.toHaveLength(0);
    });
  });

  it("aborts editing a previous user message", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "conversation-1",
          title: "Editable chat",
          titleEdited: false,
          model: "qwen3:latest",
          systemPrompt: "",
          createdAt: now,
          updatedAt: now,
          steps: [
            {
              id: "system-1",
              kind: "system",
              title: "System Prompt",
              content: "",
              createdAt: now,
              expanded: true,
            },
            {
              id: "user-1",
              kind: "user",
              title: "User",
              content: "Original prompt",
              createdAt: now,
              expanded: true,
            },
            {
              id: "assistant-1",
              kind: "assistant",
              title: "Assistant",
              content: "Original reply",
              createdAt: now,
              expanded: true,
            },
          ],
        },
      ])
    );
    window.localStorage.setItem(SELECTED_KEY, "conversation-1");

    renderWorkspace();

    await screen.findAllByText("Original prompt");
    await user.click(screen.getByRole("button", { name: "Edit message" }));

    const editInput = await screen.findByRole("textbox", { name: "Edit message" });
    await user.clear(editInput);
    await user.type(editInput, "Changed prompt");
    await user.click(await screen.findByRole("button", { name: "Abort" }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue("Changed prompt")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Original prompt")).toBeInTheDocument();
    expect(screen.getByText("Original reply")).toBeInTheDocument();
  });

  it("edits a previous user message, resends it, and discards the remainder of the conversation", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "conversation-1",
          title: "Original prompt",
          titleEdited: false,
          model: "qwen3:latest",
          systemPrompt: "",
          createdAt: now,
          updatedAt: now,
          steps: [
            {
              id: "system-1",
              kind: "system",
              title: "System Prompt",
              content: "",
              createdAt: now,
              expanded: true,
            },
            {
              id: "user-1",
              kind: "user",
              title: "User",
              content: "Original prompt",
              createdAt: now,
              expanded: true,
            },
            {
              id: "assistant-1",
              kind: "assistant",
              title: "Assistant",
              content: "Old reply",
              createdAt: now,
              expanded: true,
            },
            {
              id: "user-2",
              kind: "user",
              title: "User",
              content: "Later prompt",
              createdAt: now,
              expanded: true,
            },
          ],
        },
      ])
    );
    window.localStorage.setItem(SELECTED_KEY, "conversation-1");

    renderWorkspace();

    await screen.findAllByText("Original prompt");
    const editButtons = screen.getAllByRole("button", { name: "Edit message" });
    await user.click(editButtons[0]);

    const editInput = screen.getByRole("textbox", { name: "Edit message" });
    const editStep = editInput.closest('[data-step-kind="user"]');
    await user.clear(editInput);
    await user.type(editInput, "Edited prompt");
    expect(editStep).not.toBeNull();
    expect(within(editStep!).getByRole("button", { name: "Send" })).toBeInTheDocument();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getAllByText("Edited prompt")).not.toHaveLength(0);
    });

    expect(screen.queryByText("Old reply")).not.toBeInTheDocument();
    expect(screen.queryByText("Later prompt")).not.toBeInTheDocument();
    expect(screen.getAllByText("Edited prompt")).not.toHaveLength(0);
    expect(await screen.findByText("Streamed answer")).toBeInTheDocument();
    expect(mockStartStream).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({
            kind: "user",
            content: "Edited prompt",
          }),
        ]),
      })
    );

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const storedConversations = JSON.parse(raw!);
    expect(storedConversations[0].steps).toHaveLength(3);
    expect(storedConversations[0].steps[1].content).toBe("Edited prompt");
    expect(storedConversations[0].steps[2].content).toBe("Streamed answer");
  });

  it("regenerates an assistant message and discards the later conversation tail", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "conversation-1",
          title: "Original prompt",
          titleEdited: false,
          model: "qwen3:latest",
          systemPrompt: "",
          createdAt: now,
          updatedAt: now,
          steps: [
            {
              id: "system-1",
              kind: "system",
              title: "System Prompt",
              content: "",
              createdAt: now,
              expanded: true,
            },
            {
              id: "user-1",
              kind: "user",
              title: "User",
              content: "Original prompt",
              createdAt: now,
              expanded: true,
            },
            {
              id: "reasoning-1",
              kind: "reasoning",
              title: "Reasoning",
              content: "Prior reasoning",
              createdAt: now,
              expanded: true,
            },
            {
              id: "assistant-1",
              kind: "assistant",
              title: "Assistant",
              content: "Old reply",
              createdAt: now,
              expanded: true,
            },
            {
              id: "user-2",
              kind: "user",
              title: "User",
              content: "Later prompt",
              createdAt: now,
              expanded: true,
            },
          ],
        },
      ])
    );
    window.localStorage.setItem(SELECTED_KEY, "conversation-1");

    renderWorkspace();

    await screen.findByText("Old reply");
    await user.click(screen.getByRole("button", { name: "Regenerate response" }));

    await waitFor(() => {
      expect(screen.queryByText("Old reply")).not.toBeInTheDocument();
    });

    expect(screen.queryByText("Prior reasoning")).not.toBeInTheDocument();
    expect(screen.queryByText("Later prompt")).not.toBeInTheDocument();
    expect(await screen.findByText("Streamed answer")).toBeInTheDocument();
    expect(mockStartStream).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({
            kind: "system",
          }),
          expect.objectContaining({
            kind: "user",
            content: "Original prompt",
          }),
        ]),
      })
    );

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const storedConversations = JSON.parse(raw!);
    expect(storedConversations[0].steps).toHaveLength(3);
    expect(storedConversations[0].steps[1].content).toBe("Original prompt");
    expect(storedConversations[0].steps[2].content).toBe("Streamed answer");
  });

  it("shows a spinner and stop button while waiting for a response", async () => {
    const user = userEvent.setup();
    let resolveStream: ((value: unknown[]) => void) | null = null;

    mockStartStream.mockReturnValueOnce({
      promise: new Promise((resolve) => {
        resolveStream = resolve;
      }),
      stop: vi.fn(),
    });

    renderWorkspace();

    await screen.findAllByText("qwen3:latest");
    const prompt = screen.getByRole("textbox", { name: "User Prompt" });
    await user.type(prompt, "Test prompt");
    await user.keyboard("{Enter}");

    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    resolveStream?.([
      {
        id: "assistant-2",
        kind: "assistant",
        title: "Assistant",
        content: "Done",
        createdAt: new Date().toISOString(),
        expanded: true,
      },
    ]);

    await waitFor(() => {
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });
  });

  it("auto-scrolls once when a streamed response starts", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    let resolveStream: ((steps: unknown[]) => void) | null = null;

    mockStartStream.mockImplementationOnce((_send: unknown, request: { onDelta: (steps: unknown[]) => void }) => {
      // Fire deltas immediately so the component renders streaming steps
      queueMicrotask(() => {
        request.onDelta([
          {
            id: "assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Partial",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ]);
        request.onDelta([
          {
            id: "assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Partial with more text",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ]);
      });

      const promise = new Promise<unknown[]>((resolve) => {
        resolveStream = resolve;
      });
      return { promise, stop: vi.fn() };
    });

    renderWorkspace();

    await screen.findAllByText("qwen3:latest");
    scrollIntoView.mockClear();
    const prompt = screen.getByRole("textbox", { name: "User Prompt" });
    await user.type(prompt, "Scroll test");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });

    // Resolve stream so the test completes cleanly
    await act(async () => {
      resolveStream?.([
        {
          id: "assistant-1",
          kind: "assistant",
          title: "Assistant",
          content: "Streamed answer",
          createdAt: new Date().toISOString(),
          expanded: true,
        },
      ]);
    });
  });

  it("deletes conversations and removes them from persisted storage", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "conversation-1",
          title: "First chat",
          titleEdited: false,
          model: "qwen3:latest",
          systemPrompt: "",
          createdAt: now,
          updatedAt: now,
          steps: [
            { id: "system-1", kind: "system", title: "System Prompt", content: "", createdAt: now, expanded: true },
            { id: "user-1", kind: "user", title: "User", content: "Hello", createdAt: now, expanded: true },
          ],
        },
        {
          id: "conversation-2",
          title: "Second chat",
          titleEdited: false,
          model: "qwen3:latest",
          systemPrompt: "",
          createdAt: now,
          updatedAt: now,
          steps: [
            { id: "system-2", kind: "system", title: "System Prompt", content: "", createdAt: now, expanded: true },
            { id: "user-2", kind: "user", title: "User", content: "Hi", createdAt: now, expanded: true },
          ],
        },
      ])
    );
    window.localStorage.setItem(SELECTED_KEY, "conversation-1");

    renderWorkspace();

    await screen.findByText("First chat");

    const deleteButtons = screen.getAllByRole("button", {
      name: /Delete conversation/,
    });
    await user.click(deleteButtons[0]);

    // Confirm deletion in the dialog
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      const conversations = JSON.parse(raw!);
      expect(conversations.some((c: { id: string }) => c.id === "conversation-1")).toBe(false);
      expect(conversations.some((c: { id: string }) => c.id === "conversation-2")).toBe(true);
    });
  });

  it("opens the tools sidebar and toggles web search", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await screen.findAllByText("qwen3:latest");
    // Open the right sidebar
    await user.click(screen.getByRole("button", { name: "Expand tools sidebar" }));
    // Expand the Tools section (use role selector to avoid matching the "Tools" checkbox label in Client settings)
    await user.click(screen.getByRole("button", { name: "Tools" }));
    // Expand the built-in subsection
    await user.click(screen.getByText("built-in"));

    const checkbox = screen.getByRole("checkbox", { name: /web_search/i });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /web_search/i })).toBeChecked();
    });
  });

  it("shows request JSON reflecting the committed conversation steps", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "conversation-1",
          title: "Test chat",
          titleEdited: false,
          model: "qwen3:latest",
          systemPrompt: "",
          createdAt: now,
          updatedAt: now,
          steps: [
            { id: "system-1", kind: "system", title: "System Prompt", content: "", createdAt: now, expanded: true },
            { id: "user-1", kind: "user", title: "User", content: "Hello", createdAt: now, expanded: true },
            { id: "assistant-1", kind: "assistant", title: "Assistant", content: "Hi there", createdAt: now, expanded: true },
          ],
        },
      ])
    );
    window.localStorage.setItem(SELECTED_KEY, "conversation-1");

    renderWorkspace();

    await screen.findByText("Test chat");
    await user.click(screen.getByRole("button", { name: "View request JSON" }));

    const preview = screen.getByText((_, element) => element?.tagName === "PRE");
    const payload = JSON.parse(preview.textContent ?? "{}");
    expect(payload.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Hello" }),
        expect.objectContaining({ role: "assistant", content: "Hi there" }),
      ])
    );

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Request JSON" })).not.toBeInTheDocument();
    });
  });

  it("shows a copy action in the request JSON modal", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "conversation-1",
          title: "Test chat",
          titleEdited: false,
          model: "qwen3:latest",
          systemPrompt: "",
          createdAt: now,
          updatedAt: now,
          steps: [
            { id: "system-1", kind: "system", title: "System Prompt", content: "", createdAt: now, expanded: true },
            { id: "user-1", kind: "user", title: "User", content: "Hello", createdAt: now, expanded: true },
          ],
        },
      ])
    );
    window.localStorage.setItem(SELECTED_KEY, "conversation-1");

    renderWorkspace();

    await screen.findByText("Test chat");
    await user.type(screen.getByRole("textbox", { name: "User Prompt" }), "Draft prompt");
    await user.click(screen.getByRole("button", { name: "View request JSON" }));

    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();
  });

  it("sends only active tools to the backend", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await screen.findAllByText("qwen3:latest");
    // Open the right sidebar and enable web_search
    await user.click(screen.getByRole("button", { name: "Expand tools sidebar" }));
    await user.click(screen.getByRole("button", { name: "Tools" }));
    await user.click(screen.getByText("built-in"));
    await user.click(screen.getByRole("checkbox", { name: /web_search/i }));

    const prompt = screen.getByRole("textbox", { name: "User Prompt" });
    await user.type(prompt, "Need sources");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          tools: [
            expect.objectContaining({
              name: "web_search",
            }),
          ],
        })
      );
    });
  });

  it("shows request JSON including tool call when a tool call is pending", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "conversation-1",
          title: "Tool chat",
          titleEdited: false,
          model: "qwen3:latest",
          systemPrompt: "",
          createdAt: now,
          updatedAt: now,
          availableTools: [
            {
              id: "web-search",
              name: "web_search",
              description: "Searches the web and returns a short source-backed summary.",
              inputSchema: `{
  "query": "string",
  "recency_days": "number?"
}`,
            },
          ],
          activeToolIds: ["web-search"],
          steps: [
            {
              id: "system-1",
              kind: "system",
              title: "System Prompt",
              content: "",
              createdAt: now,
              expanded: true,
            },
            {
              id: "user-1",
              kind: "user",
              title: "User",
              content: "Search for patterns",
              createdAt: now,
              expanded: true,
            },
            {
              id: "tool-call-1",
              kind: "tool_call",
              title: "Tool Call",
              content: "Requested web_search",
              createdAt: now,
              expanded: true,
              toolCall: {
                name: "web_search",
                arguments: {
                  query: "local ui patterns",
                },
              },
            },
          ],
        },
      ])
    );
    window.localStorage.setItem(SELECTED_KEY, "conversation-1");

    renderWorkspace();

    await screen.findByRole("textbox", { name: "User Prompt" });
    await user.click(screen.getByRole("button", { name: "View request JSON" }));

    const preview = screen.getByText((_, element) => element?.tagName === "PRE");
    const payload = JSON.parse(preview.textContent ?? "{}");
    // The preview includes the user message and the pending assistant tool call
    expect(payload.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Search for patterns" }),
        expect.objectContaining({
          role: "assistant",
          tool_calls: expect.arrayContaining([
            expect.objectContaining({
              function: expect.objectContaining({ name: "web_search" }),
            }),
          ]),
        }),
      ])
    );
  });

});
