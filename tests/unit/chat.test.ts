import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  createConversation,
  createId,
  createStep,
  ensureSystemPromptStep,
  fallbackModels,
  formatTimestamp,
  inferTitle,
  loadConversations,
  saveConversations,
  loadSidebarState,
  saveSidebarState,
  ensureConversationTools,
  loadConversationOrder,
  saveConversationOrder,
  saveSelectedConversationId,
  loadSelectedConversationId,
  CONVERSATION_ORDER_KEY,
  SELECTED_KEY,
  SIDEBAR_STATE_KEY,
  STORAGE_KEY,
} from "@/src/lib/chat";
import type { ToolDefinition } from "@/src/types/chat";

const testTools: ToolDefinition[] = [
  {
    id: "web-search",
    name: "web_search",
    description: "Searches the web using Brave Search and returns relevant results.",
    inputSchema: JSON.stringify({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    }),
  },
];

describe("chat helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("creates a conversation with a seeded system step", () => {
    const conversation = createConversation("qwen3:latest");

    expect(conversation.model).toBe("qwen3:latest");
    expect(conversation.steps).toHaveLength(1);
    expect(conversation.steps[0]?.kind).toBe("system");
    expect(conversation.systemPrompt).toBe("");
  });

  it("infers the title from the first user step", () => {
    const title = inferTitle([
      {
        id: "1",
        kind: "system",
        title: "System Prompt",
        content: "Be concise.",
        createdAt: new Date().toISOString(),
      },
      {
        id: "2",
        kind: "user",
        title: "User",
        content: "Explain how streaming responses work in Ollama.",
        createdAt: new Date().toISOString(),
      },
    ]);

    expect(title).toBe("Explain how streaming responses work in Ol");
  });

  it("loads a blank conversation when local storage is empty", () => {
    const conversations = loadConversations(testTools);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe("New conversation");
    expect(conversations[0]?.availableTools).toEqual(testTools);
    expect(conversations[0]?.activeToolIds).toEqual([]);
    expect(conversations[0]?.steps).toHaveLength(1);
    expect(conversations[0]?.steps[0]?.kind).toBe("system");
  });

  it("round-trips persisted conversations and re-seeds configured tools", () => {
    const conversations = [createConversation("llama3.2:latest", testTools)];

    saveConversations(conversations);

    expect(loadConversations(testTools)).toEqual(conversations);
  });

  it("formats timestamps into a human-readable label", () => {
    const label = formatTimestamp("2026-03-20T11:00:00.000Z");

    expect(label).toMatch(/Mar/);
  });
});

// ── Gate-remediation additions: previously zero-assertion functions
// (mutation survivor closure) ────────────────────────────────────────
//
// loadSidebarState/saveSidebarState/DEFAULT_SIDEBAR_STATE had no dedicated
// test anywhere in the suite before this pass -- every field of the
// default object, and both branches of the corrupt-JSON fallback, were
// executed only incidentally (via module import) without any assertion
// ever reading them back, which is exactly the shape of survivor Stryker
// flags as "covered but unasserted".
// Single source of truth for loadSidebarState's documented defaults,
// shared by both tests below that need to compare against them — rather
// than each pinning its own copy (or, worse, comparing the function's
// output to itself).
const DEFAULT_SIDEBAR_STATE_FOR_TEST = {
  sidebarOpen: true,
  rightSidebarOpen: false,
  modelSectionOpen: false,
  reasoningEffortSectionOpen: false,
  tempSectionOpen: false,
  maxTokensSectionOpen: false,
  toolsSectionOpen: false,
  clientSectionOpen: false,
  renderMarkdown: true,
  showTokens: false,
  showTour: true,
  showExamples: true,
  collapseReasoning: false,
  collapseToolCalls: false,
  collapseTools: true,
  collapseServerMessages: false,
  hideSystemPrompt: false,
  subsections: {},
};

describe("sidebar state persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns the exact documented defaults when nothing is stored", () => {
    expect(loadSidebarState()).toEqual(DEFAULT_SIDEBAR_STATE_FOR_TEST);
  });

  it("round-trips a saved state exactly", () => {
    const state = {
      ...loadSidebarState(),
      sidebarOpen: false,
      showTokens: true,
      subsections: { builtin: true },
    };
    saveSidebarState(state);
    expect(loadSidebarState()).toEqual(state);
  });

  it("merges a partial stored object over the defaults, rather than replacing them wholesale", () => {
    window.localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify({ showTokens: true }));
    const result = loadSidebarState();
    expect(result.showTokens).toBe(true);
    expect(result.sidebarOpen).toBe(true); // untouched default survives the merge
  });

  it("falls back to the defaults when the stored value is corrupt JSON", () => {
    window.localStorage.setItem(SIDEBAR_STATE_KEY, "{not valid json");
    expect(loadSidebarState()).toEqual(DEFAULT_SIDEBAR_STATE_FOR_TEST);
  });
});

describe("ensureConversationTools: tool-list reconciliation", () => {
  it("re-seeds configured tools ahead of any stale extra tools the conversation still carries", () => {
    const configured: ToolDefinition[] = [
      { id: "web-search", name: "web_search", description: "d", inputSchema: "{}" },
    ];
    const conversation = {
      ...createConversation("qwen3:latest"),
      availableTools: [{ id: "stale-tool", name: "stale", description: "d", inputSchema: "{}" }],
      activeToolIds: ["stale-tool", "web-search"],
    };

    const result = ensureConversationTools(conversation, configured);

    expect(result.availableTools.map((t) => t.id)).toEqual(["web-search", "stale-tool"]);
    // activeToolIds is filtered down to ids that still exist in the merged
    // list -- "web-search" survives, "stale-tool" also survives (it's kept
    // in availableTools even though it's no longer configured).
    expect(result.activeToolIds.sort()).toEqual(["stale-tool", "web-search"]);
  });

  it("does not duplicate an existing tool whose id already matches ONE of several configured tools (isolates .some from .every)", () => {
    // Two configured tools, where the existing (stale) entry's id matches
    // only the FIRST one. `.some(...)` correctly excludes it from the
    // "extra" tail (it's already covered by the `...tools` spread);
    // `.every(...)` would incorrectly conclude "not fully covered" (since
    // the SECOND configured tool doesn't match) and duplicate it.
    const configured: ToolDefinition[] = [
      { id: "web-search", name: "web_search", description: "d", inputSchema: "{}" },
      { id: "calculator", name: "calculator", description: "d", inputSchema: "{}" },
    ];
    const conversation = {
      ...createConversation("qwen3:latest"),
      availableTools: [{ id: "web-search", name: "stale copy of web-search", description: "old", inputSchema: "{}" }],
      activeToolIds: [],
    };

    const result = ensureConversationTools(conversation, configured);

    expect(result.availableTools.map((t) => t.id)).toEqual(["web-search", "calculator"]);
  });

  it("drops an activeToolIds entry that no longer corresponds to any available tool", () => {
    const conversation = {
      ...createConversation("qwen3:latest"),
      availableTools: [],
      activeToolIds: ["ghost-tool"],
    };

    const result = ensureConversationTools(conversation, []);
    expect(result.activeToolIds).toEqual([]);
  });
});

describe("conversation order and selected-id persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a saved conversation order", () => {
    saveConversationOrder(["b", "a", "c"]);
    expect(loadConversationOrder()).toEqual(["b", "a", "c"]);
  });

  it("returns null when nothing is stored, and null (not throwing) on corrupt JSON", () => {
    expect(loadConversationOrder()).toBeNull();
    window.localStorage.setItem("ollamable.conversationOrder", "{not valid json");
    expect(loadConversationOrder()).toBeNull();
  });

  it("saves and clears the selected conversation id depending on truthiness", () => {
    saveSelectedConversationId("conv-1");
    expect(loadSelectedConversationId()).toBe("conv-1");

    saveSelectedConversationId("");
    expect(loadSelectedConversationId()).toBeNull();
  });
});

// ── Second gate-remediation pass (mutation survivor closure, round 2) ──
//
// The first pass covered the functions that had no test at all. What it
// left behind is a different shape: behavior that IS executed by the
// existing tests but never read back -- the literal storage keys, the
// fallback model list, the defaults `createStep`/`createConversation`
// stamp onto a new record, and every `??`/`||` fallback in
// `ensureSystemPromptStep`, which no test ever reaches because every
// conversation a test builds comes from `createConversation` and is
// therefore already fully populated. A conversation read back from a
// previous release's localStorage is not.

describe("localStorage keys are a compatibility contract with previously-stored data", () => {
  // These four strings are the only link between a returning user's
  // saved conversations and this build. Renaming one silently orphans
  // everything that user has, with no error anywhere -- the app just
  // starts empty. Every other test in this file goes through the
  // exported constant, so it cannot notice a rename; these assertions
  // are the ones that pin the literal wire format.
  it("stores each kind of state under its documented key", () => {
    expect(STORAGE_KEY).toBe("ollamable.conversations");
    expect(SELECTED_KEY).toBe("ollamable.selectedConversationId");
    expect(SIDEBAR_STATE_KEY).toBe("ollamable.sidebarState");
    expect(CONVERSATION_ORDER_KEY).toBe("ollamable.conversationOrder");
  });

  it("writes a saved conversation under exactly that key, readable without going through the module", () => {
    const conversations = [createConversation("qwen3:latest")];
    saveConversations(conversations);

    const raw = window.localStorage.getItem("ollamable.conversations");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toHaveLength(1);
  });
});

describe("createId: a usable id even where crypto.randomUUID is unavailable", () => {
  // Not hypothetical: this app white-screens on a plain-HTTP non-localhost
  // origin precisely because `crypto.randomUUID` is secure-context-only,
  // so the degraded branch is the one that runs for a user browsing the
  // dev server from another machine. Both halves of the guard have to be
  // separately load-bearing -- an engine can expose `crypto` without
  // exposing `randomUUID`.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the platform UUID generator when the platform offers one", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-3333-4444-555555555555" });
    expect(createId()).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("falls back to a locally-generated id when there is no crypto object at all", () => {
    vi.stubGlobal("crypto", undefined);
    const id = createId();
    expect(id).toMatch(/^[a-z0-9]{1,8}$/);
  });

  it("falls back when crypto exists but does not expose randomUUID, rather than throwing", () => {
    vi.stubGlobal("crypto", { getRandomValues: () => new Uint8Array(0) });
    const id = createId();
    expect(id).toMatch(/^[a-z0-9]{1,8}$/);
  });

  it("produces distinct ids on the fallback path, so two steps created together never collide", () => {
    vi.stubGlobal("crypto", undefined);
    const ids = new Set(Array.from({ length: 50 }, () => createId()));
    expect(ids.size).toBe(50);
  });
});

describe("a newly created step and conversation carry the defaults the UI renders against", () => {
  it("creates a step that is expanded, so its content is visible without a click", () => {
    const step = createStep("assistant", "Assistant", "hello");
    expect(step.expanded).toBe(true);
    expect(step.kind).toBe("assistant");
    expect(step.title).toBe("Assistant");
    expect(step.content).toBe("hello");
  });

  it("creates a conversation with no tools when the caller names none, rather than inventing any", () => {
    const conversation = createConversation("qwen3:latest");
    expect(conversation.availableTools).toEqual([]);
    expect(conversation.activeToolIds).toEqual([]);
  });

  it("marks a new conversation's title as not user-edited, so it can still be inferred from the first message", () => {
    expect(createConversation("qwen3:latest").titleEdited).toBe(false);
  });

  it("starts a conversation on the first fallback model when storage is empty", () => {
    expect(loadConversations([])[0]?.model).toBe("qwen3:latest");
  });

  it("offers the documented fallback models when the server's model list is unavailable", () => {
    expect(fallbackModels).toEqual([
      { name: "qwen3:latest", family: "qwen", families: ["qwen"], parameterSize: "8B" },
      { name: "llama3.2:latest", family: "llama", families: ["llama"], parameterSize: "3B" },
    ]);
  });
});

describe("inferTitle: the conversation list label before and after the first message", () => {
  it("shows the placeholder label while the conversation has no user message yet", () => {
    expect(inferTitle([])).toBe("New conversation");
    expect(
      inferTitle([
        {
          id: "1",
          kind: "system",
          title: "System Prompt",
          content: "Be concise.",
          createdAt: new Date().toISOString(),
        },
      ])
    ).toBe("New conversation");
  });

  it("keeps the placeholder rather than an empty label when the first user message is blank", () => {
    expect(
      inferTitle([
        { id: "1", kind: "user", title: "User", content: "", createdAt: new Date().toISOString() },
      ])
    ).toBe("New conversation");
  });
});

describe("loadConversations: a corrupt store degrades to a usable blank conversation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns one blank conversation instead of throwing when the stored payload is not JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not valid json");

    const conversations = loadConversations([]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.model).toBe("qwen3:latest");
    expect(conversations[0]?.steps).toHaveLength(1);
  });
});

describe("ensureSystemPromptStep: a conversation read back from an older release is made whole", () => {
  // Every conversation these tests build is deliberately PARTIAL -- the
  // shape a record saved by an earlier build has, not the shape
  // createConversation produces. That is the only way the defaults in
  // this function are reachable at all.
  const baseStep = (kind: string, content: string) => ({
    id: `id-${kind}`,
    kind: kind as never,
    title: kind,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("synthesizes a system step for a conversation that has none, and puts it first", () => {
    const conversation = {
      id: "c1",
      title: "Old conversation",
      model: "qwen3:latest",
      systemPrompt: "Be terse.",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      steps: [baseStep("user", "hi")],
    } as never;

    const result = ensureSystemPromptStep(conversation);

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.kind).toBe("system");
    expect(result.steps[0]?.title).toBe("System Prompt");
    expect(result.steps[0]?.content).toBe("Be terse.");
    expect(result.steps[0]?.expanded).toBe(true);
    expect(result.steps[0]?.id).toEqual(expect.any(String));
    // The conversation's own creation time is reused for the synthesized
    // step, so the transcript does not gain a step that appears newer
    // than the messages below it.
    expect(result.steps[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.steps[1]?.content).toBe("hi");
  });

  it("stamps the synthesized system step with the current time when the conversation has no creation time", () => {
    const conversation = {
      id: "c1",
      title: "Old conversation",
      model: "qwen3:latest",
      systemPrompt: "",
      steps: [baseStep("user", "hi")],
    } as never;

    const createdAt = ensureSystemPromptStep(conversation).steps[0]?.createdAt as string;
    expect(createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(createdAt))).toBe(false);
  });

  it("promotes an existing system step to the front instead of duplicating it", () => {
    const conversation = {
      id: "c1",
      title: "Old conversation",
      model: "qwen3:latest",
      systemPrompt: "Be terse.",
      createdAt: "2026-01-01T00:00:00.000Z",
      steps: [baseStep("user", "hi"), { ...baseStep("system", "stale prompt"), expanded: false }],
    } as never;

    const result = ensureSystemPromptStep(conversation);

    expect(result.steps.filter((step) => step.kind === "system")).toHaveLength(1);
    expect(result.steps[0]?.kind).toBe("system");
    expect(result.steps[0]?.id).toBe("id-system");
    // The conversation's systemPrompt wins over whatever text the stored
    // step carried, so the editor and the transcript cannot disagree.
    expect(result.steps[0]?.content).toBe("Be terse.");
    // A step the user had collapsed stays collapsed.
    expect(result.steps[0]?.expanded).toBe(false);
    expect(result.steps[1]?.content).toBe("hi");
  });

  it("leaves an existing system step expanded when the stored record predates the expanded flag", () => {
    const conversation = {
      id: "c1",
      title: "Old conversation",
      model: "qwen3:latest",
      systemPrompt: "Be terse.",
      createdAt: "2026-01-01T00:00:00.000Z",
      steps: [baseStep("system", "stale prompt")],
    } as never;

    expect(ensureSystemPromptStep(conversation).steps[0]?.expanded).toBe(true);
  });

  it("treats a conversation with no systemPrompt field as having an empty prompt, not an absent one", () => {
    const conversation = {
      id: "c1",
      title: "Old conversation",
      model: "qwen3:latest",
      createdAt: "2026-01-01T00:00:00.000Z",
      steps: [baseStep("system", "stale prompt")],
    } as never;

    const result = ensureSystemPromptStep(conversation);
    expect(result.systemPrompt).toBe("");
    expect(result.steps[0]?.content).toBe("");
  });

  it("fills in the tool fields and the title-edited flag a pre-tools record does not carry", () => {
    const conversation = {
      id: "c1",
      title: "Old conversation",
      model: "qwen3:latest",
      systemPrompt: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      steps: [baseStep("system", "")],
    } as never;

    const result = ensureSystemPromptStep(conversation);
    expect(result.availableTools).toEqual([]);
    expect(result.activeToolIds).toEqual([]);
    expect(result.titleEdited).toBe(false);
  });

  it("does not overwrite a title the user has already edited", () => {
    const conversation = {
      id: "c1",
      title: "My title",
      titleEdited: true,
      model: "qwen3:latest",
      systemPrompt: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      steps: [baseStep("system", "")],
    } as never;

    expect(ensureSystemPromptStep(conversation).titleEdited).toBe(true);
  });
});

describe("ensureConversationTools: which enabled tools survive a reconciliation", () => {
  it("keeps an enabled tool that is still available, rather than dropping it with the stale ones", () => {
    // Exactly ONE tool in the merged list, so "is this id present" and
    // "does this id differ from some tool" give opposite answers -- the
    // multi-tool cases elsewhere in this file cannot tell them apart.
    const configured = [{ id: "web-search", name: "web_search", description: "d", inputSchema: "{}" }];
    const conversation = {
      ...createConversation("qwen3:latest"),
      availableTools: [],
      activeToolIds: ["web-search"],
    };

    expect(ensureConversationTools(conversation, configured).activeToolIds).toEqual(["web-search"]);
  });

  it("drops an enabled tool that is gone while keeping the ones that remain", () => {
    const configured = [
      { id: "web-search", name: "web_search", description: "d", inputSchema: "{}" },
      { id: "calculator", name: "calculator", description: "d", inputSchema: "{}" },
    ];
    const conversation = {
      ...createConversation("qwen3:latest"),
      availableTools: [],
      activeToolIds: ["web-search", "removed-tool", "calculator"],
    };

    expect(ensureConversationTools(conversation, configured).activeToolIds).toEqual([
      "web-search",
      "calculator",
    ]);
  });

  it("offers exactly the configured tools for a conversation saved before tools existed", () => {
    const configured = [{ id: "web-search", name: "web_search", description: "d", inputSchema: "{}" }];
    const conversation = { ...createConversation("qwen3:latest") } as Record<string, unknown>;
    delete conversation.availableTools;
    delete conversation.activeToolIds;

    const result = ensureConversationTools(conversation as never, configured);
    expect(result.availableTools).toEqual(configured);
    expect(result.activeToolIds).toEqual([]);
  });
});

// ── Residual survivors after this pass: do not chase ──────────────────
//
// src/lib/chat.ts scores 206/211 with five live mutants, none of them an
// assertion gap:
//
//   * The three `if (!raw)` early returns (loadSidebarState,
//     loadConversationOrder, loadConversations) are EQUIVALENT. Deleting
//     the guard leaves `JSON.parse(null)`, which parses the string
//     "null" to `null` -- and `{...DEFAULTS, ...null}` is DEFAULTS, a
//     `null` return is already the documented empty answer, and
//     `null.map(...)` lands in the catch that returns the same blank
//     conversation. The guard is a fast path, not a behavior.
//   * `ensureConversationTools`' `activeToolIds ?? []` is EQUIVALENT:
//     whatever stands in for the empty array is immediately filtered
//     against the merged tool list, and no tool carries that id.
//   * The `console.warn` text on the give-up path is SIDE-EFFECT-ONLY.
//     That the call happens at all is already asserted in
//     chat-content-tokens-quota.test.ts; the wording is diagnostic, not
//     a contract, and pinning it would only make the message painful to
//     improve.
