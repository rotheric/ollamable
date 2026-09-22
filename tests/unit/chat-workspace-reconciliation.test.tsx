/**
 * chat-workspace.tsx wiring tests for the S4 request-preview panel
 * (epic-token-view story S4): │-separated outgoing messages, verbatim
 * chat-template display, and content-token reconciliation, exercised
 * through the REAL component tree opened via the same "View request
 * JSON" button the pre-existing Request JSON dialog already uses.
 *
 * Covers AC-UX-5, AC-UX-6, and confirms this panel is distinct from both
 * the pre-existing model-metadata dialog's own Template section
 * (chat-workspace.tsx ~3067) and the per-step JSON inspect dialog (VQ-S4-
 * 004(b)).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeRegistry } from "@/src/components/theme-registry";
import { ChatWorkspace } from "@/src/components/chat-workspace";
import { SELECTED_KEY, STORAGE_KEY, SIDEBAR_STATE_KEY } from "@/src/lib/chat";
import { SEPARATOR } from "@/src/lib/token-view";

const { mockSend, mockStartStream, mockCancelAll, mockCancelPendingTokenize, mockTokenize } = vi.hoisted(() => ({
  mockSend: vi.fn(() => true),
  mockStartStream: vi.fn(),
  mockCancelAll: vi.fn(),
  mockCancelPendingTokenize: vi.fn(),
  mockTokenize: vi.fn((_send: unknown, _model: string, text: string) =>
    Promise.resolve({ tokens: text.match(/\S+|\s+/g) ?? [text], tokenIds: [] })
  ),
}));

vi.mock("@/src/lib/use-websocket", () => ({
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
    fetchAllModels: vi.fn().mockResolvedValue([
      { name: "qwen3:latest", provider: "ollama", providerName: "Ollama", family: "qwen", families: ["qwen"], parameterSize: "8B" },
      // Reuses a name already present in fallbackModels (src/lib/chat.ts):
      // ChatWorkspace's model-correction effect runs once against the
      // synchronous fallbackModels default (providers all undefined)
      // before this mocked fetchAllModels() promise settles, and only a
      // name it already recognises survives that first pass to be
      // corrected again — by provider, this time — once the real list
      // arrives. A wholly novel model name gets reset to fallbackModels[0]
      // on that first pass and never recovers.
      { name: "llama3.2:latest", provider: "minimax", providerName: "MiniMax" },
    ]),
    fetchModelMeta: vi.fn().mockResolvedValue({
      name: "qwen3:latest",
      family: "qwen",
      template: "{{ .System }}\n{{ .Prompt }}",
    }),
    fetchTools: vi.fn().mockResolvedValue([]),
  };
});

function renderWorkspace() {
  return render(
    <ThemeRegistry>
      <ChatWorkspace />
    </ThemeRegistry>
  );
}

function seedConversation(
  steps: Array<Record<string, unknown>>,
  overrides: { model?: string; provider?: string } = {}
) {
  const now = new Date().toISOString();
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      {
        id: "conversation-1",
        title: "Reconciliation chat",
        titleEdited: false,
        model: overrides.model ?? "qwen3:latest",
        provider: overrides.provider ?? "ollama",
        systemPrompt: "",
        createdAt: now,
        updatedAt: now,
        steps: [
          { id: "system-1", kind: "system", title: "System Prompt", content: "be terse", createdAt: now, expanded: true },
          { id: "user-1", kind: "user", title: "User", content: "hi there", createdAt: now, expanded: true },
          ...steps,
        ],
      },
    ])
  );
  window.localStorage.setItem(SELECTED_KEY, "conversation-1");
  window.localStorage.setItem(
    SIDEBAR_STATE_KEY,
    JSON.stringify({ rightSidebarOpen: false, clientSectionOpen: false, renderMarkdown: true, showTokens: true })
  );
}

describe("chat-workspace request-preview panel (S4)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("ollamable.tourCompleted", "true");
    mockStartStream.mockClear();
    mockSend.mockClear();
    mockCancelAll.mockClear();
    mockCancelPendingTokenize.mockClear();
    mockTokenize.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("AC-UX-5: the request-preview panel shows │-separated outgoing messages and the verbatim /api/show template, distinct from the model-metadata dialog", async () => {
    const user = userEvent.setup();
    seedConversation([
      { id: "assistant-1", kind: "assistant", title: "Assistant", content: "hello", createdAt: new Date().toISOString(), expanded: true, usage: { inputTokens: 30 } },
    ]);
    renderWorkspace();
    await screen.findByText("Reconciliation chat");

    await user.click(screen.getByRole("button", { name: "View request JSON" }));

    const panel = await screen.findByTestId("request-preview-extras");
    await waitFor(() => {
      expect(within(panel).getByTestId("chat-template").textContent).toBe("{{ .System }}\n{{ .Prompt }}");
    });
    // The outgoing-message tokenize round trip is debounced
    // (COMPUTED_SOURCE_DEBOUNCE_MS, S4-F2) and is not gated by the
    // (undebounced) template fetch above, so it may still be in flight
    // here — wait for it rather than asserting synchronously.
    await waitFor(() => {
      const messages = within(panel).getAllByTestId("outgoing-message");
      expect(messages.some((m) => m.textContent?.includes(SEPARATOR))).toBe(true);
    });

    // Distinct from the pre-existing model-metadata dialog: that dialog
    // isn't open at all right now.
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
  });

  it("AC-UX-6: displays the three reconciliation figures labelled 'chat-template overhead' for a tool-call-free completed turn", async () => {
    const user = userEvent.setup();
    seedConversation([
      { id: "assistant-1", kind: "assistant", title: "Assistant", content: "hello", createdAt: new Date().toISOString(), expanded: true, usage: { inputTokens: 30 } },
    ]);
    renderWorkspace();
    await screen.findByText("Reconciliation chat");

    await user.click(screen.getByRole("button", { name: "View request JSON" }));

    const figures = await screen.findByTestId("reconciliation-figures");
    expect(figures.textContent).toContain("prompt_eval_count: 30");
    expect(figures.textContent).toContain("chat-template overhead");
    expect(figures.textContent?.toLowerCase()).not.toMatch(/mismatch|error|warning/);
  });

  it("AC-UX-6 (legacy standalone tool_call step, e.g. tour/example conversations): a tool-call turn reports reconciliation-unavailable with a named reason instead of figures", async () => {
    const user = userEvent.setup();
    seedConversation([
      { id: "tool-call-1", kind: "tool_call", title: "Tool Call", content: "", createdAt: new Date().toISOString(), expanded: true, toolCall: { name: "search", arguments: {} } },
      { id: "tool-result-1", kind: "tool_result", title: "Tool Result", content: "found it", createdAt: new Date().toISOString(), expanded: true, toolResult: { name: "search" } },
      { id: "assistant-1", kind: "assistant", title: "Assistant", content: "hello", createdAt: new Date().toISOString(), expanded: true, usage: { inputTokens: 30 } },
    ]);
    renderWorkspace();
    await screen.findByText("Reconciliation chat");

    await user.click(screen.getByRole("button", { name: "View request JSON" }));

    const notice = await screen.findByTestId("reconciliation-unavailable");
    expect(notice.textContent).toMatch(/tool call/i);
    expect(screen.queryByTestId("reconciliation-figures")).not.toBeInTheDocument();
  });

  it("AC-UX-6 (merged shape the live server actually persists — ws-handler.ts folds tool_call steps into assistant.toolCalls[]): a tool-call turn reports reconciliation-unavailable with a named reason instead of figures", async () => {
    const user = userEvent.setup();
    seedConversation([
      {
        id: "assistant-1",
        kind: "assistant",
        title: "Assistant",
        content: "",
        createdAt: new Date().toISOString(),
        expanded: true,
        toolCalls: [{ name: "search", arguments: {} }],
      },
      { id: "tool-result-1", kind: "tool_result", title: "Tool Result", content: "found it", createdAt: new Date().toISOString(), expanded: true, toolResult: { name: "search" } },
      { id: "assistant-2", kind: "assistant", title: "Assistant", content: "hello", createdAt: new Date().toISOString(), expanded: true, usage: { inputTokens: 30 } },
    ]);
    renderWorkspace();
    await screen.findByText("Reconciliation chat");

    await user.click(screen.getByRole("button", { name: "View request JSON" }));

    const notice = await screen.findByTestId("reconciliation-unavailable");
    expect(notice.textContent).toMatch(/tool call/i);
    expect(screen.queryByTestId("reconciliation-figures")).not.toBeInTheDocument();
  });

  it("does not render the panel when showTokens is off", async () => {
    const user = userEvent.setup();
    seedConversation([
      { id: "assistant-1", kind: "assistant", title: "Assistant", content: "hello", createdAt: new Date().toISOString(), expanded: true, usage: { inputTokens: 30 } },
    ]);
    window.localStorage.setItem(
      SIDEBAR_STATE_KEY,
      JSON.stringify({ rightSidebarOpen: false, clientSectionOpen: false, renderMarkdown: true, showTokens: false })
    );
    renderWorkspace();
    await screen.findByText("Reconciliation chat");

    await user.click(screen.getByRole("button", { name: "View request JSON" }));
    await screen.findByText("Request JSON");
    expect(screen.queryByTestId("request-preview-extras")).not.toBeInTheDocument();
  });

  it("F7: shows an Ollama-only notice instead of the panel for an openai-compat conversation", async () => {
    const user = userEvent.setup();
    seedConversation(
      [
        { id: "assistant-1", kind: "assistant", title: "Assistant", content: "hello", createdAt: new Date().toISOString(), expanded: true, usage: { inputTokens: 30 } },
      ],
      { model: "llama3.2:latest", provider: "minimax" }
    );
    renderWorkspace();
    await screen.findByText("Reconciliation chat");

    await user.click(screen.getByRole("button", { name: "View request JSON" }));
    await screen.findByText("Request JSON");

    const notice = await screen.findByTestId("request-preview-ollama-only");
    expect(notice.textContent).toMatch(/ollama/i);
    expect(screen.queryByTestId("request-preview-extras")).not.toBeInTheDocument();
  });
});
