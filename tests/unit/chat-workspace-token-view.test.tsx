/**
 * chat-workspace.tsx wiring tests for the `showTokens` toggle and token-view
 * render branch (epic-token-view story S2).
 *
 * Covers the production-reachable boundary sources through the real
 * component tree: `stream` (a step carrying `contentTokens`, as S1's
 * ollama-client capture would leave it) and `unavailable` (a step with no
 * `contentTokens` field, as any pre-epic persisted step or localStorage
 * load would have it). The `computed`/`pending` sources — reachable only
 * once a computedSource is injected — are covered directly against
 * src/lib/token-view.ts's own exports in tests/unit/token-view.test.tsx
 * (MOCK-02-001), since chat-workspace.tsx's production call site passes no
 * computedSource until S3 lands.
 *
 * AC-UX-1, AC-UX-2, AC-UX-3, AC-UX-4, AC-UX-8, AC-ERR-1, and the
 * cross-cutting AC-UX-7 (spanned_by S1+S2).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeRegistry } from "@/src/components/theme-registry";
import { ChatWorkspace } from "@/src/components/chat-workspace";
import { fetchModelMeta } from "@/src/lib/ollama";
import { SELECTED_KEY, STORAGE_KEY, SIDEBAR_STATE_KEY } from "@/src/lib/chat";

const { mockSend, mockStartStream, mockCancelAll, mockCancelPendingTokenize, mockTokenize } = vi.hoisted(() => ({
  mockSend: vi.fn(() => true),
  mockStartStream: vi.fn(),
  mockCancelAll: vi.fn(),
  mockCancelPendingTokenize: vi.fn(),
  mockTokenize: vi.fn().mockResolvedValue({ tokens: [], tokenIds: [] }),
}));

vi.mock("@/src/lib/use-websocket", () => ({
  // Arity-3 (S3-R4): the real contract (src/lib/use-websocket.ts) takes an
  // `onClose` third argument that chat-workspace.tsx wires to
  // `BackendClient.cancelPendingTokenize()` (S3-R1). Capturing it here lets
  // tests invoke the close path directly instead of leaving it uncovered.
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
      { name: "qwen3:latest", family: "qwen", families: ["qwen"], parameterSize: "8B" },
    ]),
    fetchAllModels: vi.fn().mockResolvedValue([
      { name: "qwen3:latest", provider: "ollama", providerName: "Ollama", family: "qwen", families: ["qwen"], parameterSize: "8B" },
    ]),
    fetchModelMeta: vi.fn().mockResolvedValue({
      name: "qwen3:latest",
      family: "qwen",
      families: ["qwen"],
      parameterSize: "8B",
      format: "gguf",
      quantizationLevel: "Q4_K_M",
      capabilities: ["completion"],
    }),
    fetchTools: vi.fn().mockResolvedValue([]),
  };
});
void fetchModelMeta;

function renderWorkspace() {
  return render(
    <ThemeRegistry>
      <ChatWorkspace />
    </ThemeRegistry>
  );
}

// The app's sidebar conversation list only surfaces conversations that contain
// at least one "user" step (see chat-workspace.tsx's visibleConversations
// filter) — a fixture-only requirement, unrelated to this story's token-view
// behavior. `seedConversation` injects one such step so the seeded
// conversation (and its "Token view chat" title) is reachable via the UI.
// `userStepTokens` lets a test control that seed step's own boundary source
// (stream when supplied, unavailable when omitted) so its notice text never
// collides with the notice produced by the step actually under test.
function seedConversation(steps: Array<Record<string, unknown>>, userStepTokens?: string[]) {
  const now = new Date().toISOString();
  const seedUserStep = {
    id: "user-seed",
    kind: "user",
    title: "User",
    content: "hi",
    createdAt: now,
    expanded: true,
    ...(userStepTokens !== undefined ? { contentTokens: userStepTokens } : {}),
  };
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      {
        id: "conversation-1",
        title: "Token view chat",
        titleEdited: false,
        model: "qwen3:latest",
        systemPrompt: "",
        createdAt: now,
        updatedAt: now,
        steps: [
          { id: "system-1", kind: "system", title: "System Prompt", content: "", createdAt: now, expanded: true },
          seedUserStep,
          ...steps,
        ],
      },
    ])
  );
  window.localStorage.setItem(SELECTED_KEY, "conversation-1");
}

// Idempotent: the right-sidebar-open and Client-section-open flags persist
// across reloads (AC-UX-1 exercises exactly that), so a second call in the
// same test must not re-toggle an already-open section back closed.
async function openClientSection(user: ReturnType<typeof userEvent.setup>) {
  const expandButton = screen.queryByRole("button", { name: "Expand tools sidebar" });
  if (expandButton) {
    await user.click(expandButton);
  }
  const clientAlreadyOpen = screen.queryByRole("checkbox", { name: /token view|show tokens/i }) !== null;
  if (!clientAlreadyOpen) {
    await user.click(screen.getByRole("button", { name: "Client" }));
  }
}

describe("chat-workspace token view", () => {
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

  it("S3-R1/S3-R4: the socket's onClose runs the narrowed tokenize-cancel path, not cancelAll()", async () => {
    seedConversation([]);
    renderWorkspace();
    await screen.findByText("Token view chat");

    const onClose = (globalThis as Record<string, unknown>).__wsMockOnClose as (() => void) | undefined;
    expect(onClose).toBeTypeOf("function");

    onClose!();

    expect(mockCancelPendingTokenize).toHaveBeenCalledTimes(1);
    expect(mockCancelAll).not.toHaveBeenCalled();
  });

  it("AC-UX-1: renders a labelled showTokens switch, persists via updateSidebar, and survives reload", async () => {
    const user = userEvent.setup();
    seedConversation([]);
    const { unmount } = renderWorkspace();

    await screen.findByText("Token view chat");
    await openClientSection(user);

    const toggle = screen.getByRole("checkbox", { name: /token view|show tokens/i });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => {
      const raw = window.localStorage.getItem(SIDEBAR_STATE_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).showTokens).toBe(true);
    });

    unmount();

    // Reload: a fresh mount must pick up the persisted value.
    renderWorkspace();
    await screen.findByText("Token view chat");
    await openClientSection(user);
    expect(screen.getByRole("checkbox", { name: /token view|show tokens/i })).toBeChecked();
  });

  it("AC-UX-2 / AC-UX-8: stream-sourced step renders one text node with │ separators, a literal '|' stays distinguishable, and the stream-boundaries label shows", async () => {
    const user = userEvent.setup();
    seedConversation([
      {
        id: "assistant-1",
        kind: "assistant",
        title: "Assistant",
        content: "price: $5 | $10",
        contentTokens: ["price: ", "$5 | $10"],
        createdAt: new Date().toISOString(),
        expanded: true,
      },
    ]);
    renderWorkspace();
    await screen.findByText("Token view chat");
    await openClientSection(user);
    await user.click(screen.getByRole("checkbox", { name: /token view|show tokens/i }));

    await waitFor(() => {
      expect(screen.getByText(/stream boundaries/i)).toBeInTheDocument();
    });

    const region = screen.getByText((_, el) => el?.textContent === "price: │$5 | $10");
    expect(region.childNodes).toHaveLength(1);
    expect(region.textContent).toContain("$5 | $10");
    expect(region.textContent).not.toContain("$5 │ $10");
  });

  it("AC-UX-3: token view bypasses react-markdown regardless of renderMarkdown", async () => {
    seedConversation([
      {
        id: "assistant-1",
        kind: "assistant",
        title: "Assistant",
        content: "# Heading\n\n**bold**",
        contentTokens: ["# Heading\n\n**bold**"],
        createdAt: new Date().toISOString(),
        expanded: true,
      },
    ]);

    for (const renderMarkdown of [true, false]) {
      window.localStorage.setItem(
        SIDEBAR_STATE_KEY,
        JSON.stringify({ rightSidebarOpen: true, clientSectionOpen: true, renderMarkdown, showTokens: true })
      );
      const { unmount, container } = renderWorkspace();
      await screen.findByText("Token view chat");

      expect(container.querySelector("h1")).toBeNull();
      expect(container.querySelector("strong")).toBeNull();
      expect(container.textContent).toContain("# Heading");
      expect(container.textContent).toContain("**bold**");
      unmount();
    }
  });

  it("AC-UX-4: renders ↵ per newline and · per 2+ space run, without the leading/trailing-newline strip, and only when showTokens is true", async () => {
    const user = userEvent.setup();
    seedConversation([
      {
        id: "assistant-1",
        kind: "assistant",
        title: "Assistant",
        content: "\nfirst  line\nsecond\n",
        contentTokens: ["\nfirst  line\nsecond\n"],
        createdAt: new Date().toISOString(),
        expanded: true,
      },
    ]);
    const { container } = renderWorkspace();
    await screen.findByText("Token view chat");

    // showTokens false (default): no markers anywhere in the transcript.
    expect(container.textContent).not.toContain("↵");
    expect(container.textContent).not.toContain("·");

    await openClientSection(user);
    await user.click(screen.getByRole("checkbox", { name: /token view|show tokens/i }));

    await waitFor(() => {
      expect(container.textContent).toContain("↵");
    });
    // 3 newlines in content -> 3 arrow glyphs, including the leading one (strip bypassed).
    const arrowCount = (container.textContent?.match(/↵/g) ?? []).length;
    expect(arrowCount).toBe(3);
    expect(container.textContent).toContain("··");
  });

  it("AC-ERR-1: a step with no contentTokens renders unseparated with a visible reason, never re-tokenized", async () => {
    const user = userEvent.setup();
    seedConversation(
      [
        {
          id: "assistant-1",
          kind: "assistant",
          title: "Assistant",
          content: "legacy step, no boundaries captured",
          // no contentTokens field at all, as any pre-epic persisted step would have.
          createdAt: new Date().toISOString(),
          expanded: true,
        },
      ],
      // Give the seed user step a stream source so its notice ("stream
      // boundaries") can never collide with the singular "no token
      // boundaries" match this test asserts on below.
      ["hi"]
    );
    renderWorkspace();
    await screen.findByText("Token view chat");
    await openClientSection(user);
    await user.click(screen.getByRole("checkbox", { name: /token view|show tokens/i }));

    await waitFor(() => {
      expect(screen.getByText("legacy step, no boundaries captured")).toBeInTheDocument();
    });
    expect(screen.getByText("legacy step, no boundaries captured").textContent).not.toContain("│");
    // A visible reason notice must be present somewhere near the step.
    expect(screen.getByText(/no token boundaries/i)).toBeInTheDocument();
  });

  it("AC-UX-7 (cross-cutting): toggling showTokens on then off restores byte-identical transcript innerHTML and leaves step.content unmutated", async () => {
    const user = userEvent.setup();
    seedConversation([
      {
        id: "assistant-1",
        kind: "assistant",
        title: "Assistant",
        content: "Hello  world\nagain",
        contentTokens: ["Hello", "  world\n", "again"],
        createdAt: new Date().toISOString(),
        expanded: true,
      },
    ]);

    for (const renderMarkdown of [true, false]) {
      window.localStorage.setItem(
        SIDEBAR_STATE_KEY,
        JSON.stringify({ rightSidebarOpen: false, clientSectionOpen: false, renderMarkdown, showTokens: false })
      );
      const { container, unmount } = renderWorkspace();
      await screen.findByText("Token view chat");

      const transcript = container.querySelector('[data-tour="transcript"]');
      expect(transcript).not.toBeNull();

      // Open the Client section first: it lives behind the right sidebar
      // toggle, and expanding that sidebar independently reflows the
      // transcript's own max-width (an existing, unrelated layout effect —
      // see chat-workspace.tsx's `sidebarOpen && rightSidebarOpen ? 900 :
      // 700` transcript width). Capturing the baseline snapshot after that
      // reflow isolates the round-trip property this test actually cares
      // about — toggling showTokens on then off — from that incidental
      // layout shift.
      await openClientSection(user);
      const before = transcript!.innerHTML;

      await user.click(screen.getByRole("checkbox", { name: /token view|show tokens/i }));
      await waitFor(() => {
        expect(transcript!.innerHTML).not.toBe(before);
      });
      await user.click(screen.getByRole("checkbox", { name: /token view|show tokens/i }));
      await waitFor(() => {
        expect(transcript!.innerHTML).toBe(before);
      });

      const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
      expect(raw[0].steps.find((s: { id: string }) => s.id === "assistant-1").content).toBe("Hello  world\nagain");

      unmount();
    }
  });
});
