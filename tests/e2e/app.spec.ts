import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

// ── Configurable WebSocket chat handler ─────────────────────────────

type WsChatHandler = (
  message: Record<string, unknown>,
  ws: WebSocketRoute
) => void;

let wsChatHandler: WsChatHandler;

/**
 * Build a WsChatHandler that replies with fixed reasoning + assistant steps.
 * The content mirrors what the original Ollama HTTP mock produced.
 */
function makeMockWsHandler(
  reasoning: string,
  assistantContent: string
): WsChatHandler {
  return (message, ws) => {
    if (message.type !== "chat.send") return;
    const conversationId = message.conversationId as string;
    const now = new Date().toISOString();

    const reasoningStep = {
      id: "mock-reasoning-1",
      kind: "reasoning",
      title: "Reasoning",
      content: reasoning,
      createdAt: now,
      expanded: true,
    };
    const assistantStep = {
      id: "mock-assistant-1",
      kind: "assistant",
      title: "Assistant",
      content: assistantContent,
      createdAt: now,
      expanded: true,
    };

    ws.send(
      JSON.stringify({
        type: "chat.delta",
        conversationId,
        requestId: message.requestId,
        steps: [reasoningStep],
      })
    );
    ws.send(
      JSON.stringify({
        type: "chat.delta",
        conversationId,
        requestId: message.requestId,
        steps: [reasoningStep, assistantStep],
      })
    );
    ws.send(
      JSON.stringify({
        type: "chat.done",
        conversationId,
        requestId: message.requestId,
        steps: [reasoningStep, assistantStep],
      })
    );
  };
}

const defaultWsChatHandler = makeMockWsHandler(
  "I should show my reasoning as a separate step.",
  "This is a streamed answer from the mocked Ollama endpoint. It includes final assistant text."
);

const mockModels = {
  models: [
    {
      name: "qwen3:latest",
      provider: "ollama",
      providerName: "Ollama",
      format: "gguf",
      family: "qwen",
      families: ["qwen"],
      parameterSize: "8B",
      quantizationLevel: "Q4_K_M",
    },
    {
      name: "llama3.2:latest",
      provider: "ollama",
      providerName: "Ollama",
      format: "gguf",
      family: "llama",
      families: ["llama"],
      parameterSize: "3B",
      quantizationLevel: "Q4_K_M",
    },
    {
      name: "nomic-embed-text:latest",
      provider: "ollama",
      providerName: "Ollama",
      format: "gguf",
      family: "bert",
      families: ["bert"],
      parameterSize: "768D",
      quantizationLevel: "F16",
    },
  ],
};

const mockTools = {
  tools: [
    {
      id: "web-search",
      name: "web_search",
      description:
        "Searches the web using Brave Search and returns relevant results with titles, URLs, and snippets.",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          count: { type: "number", description: "Number of results (default 5, max 20)" },
        },
        required: ["query"],
      }),
    },
  ],
};

async function seedConversationState(
  page: Page,
  conversations: unknown,
  selectedConversationId: string
) {
  await page.addInitScript(
    ({ nextConversations, nextSelectedConversationId }) => {
      if (window.sessionStorage.getItem("ollamable.e2e.seeded")) return;
      window.sessionStorage.setItem("ollamable.e2e.seeded", "1");
      window.localStorage.setItem(
        "ollamable.conversations",
        JSON.stringify(nextConversations)
      );
      window.localStorage.setItem(
        "ollamable.selectedConversationId",
        nextSelectedConversationId
      );
      window.localStorage.setItem("ollamable.tourCompleted", "true");
    },
    {
      nextConversations: conversations,
      nextSelectedConversationId: selectedConversationId,
    }
  );
}

test.beforeEach(async ({ page }) => {
  wsChatHandler = defaultWsChatHandler;

  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("ollamable.e2e.init")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("ollamable.e2e.init", "1");
    }
    // Prevent the guided tour from auto-starting and changing selection.
    window.localStorage.setItem("ollamable.tourCompleted", "true");
  });

  // The unified server derives API URLs from window.location, so match any origin.
  await page.route("**/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockModels),
    });
  });

  await page.route("**/tools", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockTools),
    });
  });

  // Intercept WebSocket so the frontend sees wsConnected === true.
  await page.routeWebSocket(/ws/, (ws) => {
    ws.onMessage((raw) => {
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        wsChatHandler(data, ws);
      } catch {
        // ignore malformed
      }
    });
  });
});

test("loads the shell with a blank conversation and header model chip", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Ollamable").first()).toBeVisible();
  // The model chip in the header shows the selected model.
  await expect(page.getByText("qwen3:latest").first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "System prompt" })).toHaveValue("");
  await expect(page.getByRole("heading", { name: "Reasoning trace demo" })).toHaveCount(0);
});

test("creates and selects a new conversation from the sidebar", async ({ page }) => {
  await page.goto("/");

  await page.locator('button[aria-label="New chat"]').click();

  // After creating a new conversation, the model chip should still be visible.
  await expect(page.getByText("qwen3:latest").first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "System prompt" })).toHaveValue("");
});

test("edits the system prompt inline", async ({ page }) => {
  await page.goto("/");

  const systemPrompt = page.getByRole("textbox", { name: "System prompt" });
  await systemPrompt.fill("You are a rigorous local UI test assistant.");
  await page.waitForFunction(() => {
    const raw = window.localStorage.getItem("ollamable.conversations");
    return raw?.includes("You are a rigorous local UI test assistant.");
  });
  await expect(
    page.getByRole("textbox", { name: "System prompt" })
  ).toHaveValue("You are a rigorous local UI test assistant.");
});

test("system prompt remains editable after the conversation starts", async ({ page }) => {
  await page.goto("/");

  const systemPrompt = page.getByRole("textbox", { name: "System prompt" });
  await systemPrompt.fill("Keep this prompt editable after start.");

  const prompt = page.getByRole("textbox", { name: "User Prompt" });
  await prompt.fill("Start the conversation.");
  await prompt.press("Enter");

  // The system prompt stays enabled (not disabled) because the component
  // no longer locks it after messages are sent.
  await expect(systemPrompt).not.toBeDisabled();
  await expect(systemPrompt).toHaveValue("Keep this prompt editable after start.");
  await expect(
    page.locator('[data-step-kind="user"] p', { hasText: "Start the conversation." })
  ).toBeVisible();
});

test("supports model selection from the right sidebar", async ({ page }) => {
  await page.goto("/");

  // Open the right sidebar
  await page.locator('button[aria-label="Expand tools sidebar"]').click();
  // Expand the Models section
  await page.getByText("Models").click();
  // Embedding models (nomic-embed-text) should be filtered out
  await expect(page.getByText("nomic-embed-text:latest")).toHaveCount(0);
  // Click on llama3.2:latest
  await page.getByText("llama3.2:latest").click();

  await expect(page.getByText("llama3.2:latest").first()).toBeVisible();
});

test("renders distinct background colors for visible transcript roles", async ({ page }) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "User Prompt" });
  await prompt.fill("Show me a mocked streamed answer with reasoning and tool calls.");
  await prompt.press("Enter");

  const userBackground = await page
    .locator('[data-step-kind="user"]')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const assistantBackground = await page
    .locator('[data-step-kind="assistant"]')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const reasoningBackground = await page
    .locator('[data-step-kind="reasoning"]')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(userBackground).not.toBe(assistantBackground);
  expect(userBackground).not.toBe(reasoningBackground);
  expect(reasoningBackground).not.toBe(assistantBackground);
});

test("collapses and expands conversation steps", async ({ page }) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "User Prompt" });
  await prompt.fill("Collapse this user message.");
  await prompt.press("Enter");

  await expect(
    page.locator('[data-step-kind="user"] p', { hasText: "Collapse this user message." })
  ).toBeVisible();

  await page.locator('[data-step-kind="user"] [role="button"]').first().click();

  await expect(
    page.locator('[data-step-kind="user"] p', { hasText: "Collapse this user message." })
  ).toBeHidden();

  await page.locator('[data-step-kind="user"] [role="button"]').first().click();

  await expect(
    page.locator('[data-step-kind="user"] p', { hasText: "Collapse this user message." })
  ).toBeVisible();
});

test("expanding a collapsed user step reveals the edit button", async ({ page }) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "User Prompt" });
  await prompt.fill("Edit this collapsed message.");
  await prompt.press("Enter");

  const userStep = page.locator('[data-step-kind="user"]').first();
  // Collapse
  await userStep.getByRole("button").first().click();
  await expect(
    page.locator('[data-step-kind="user"] p', { hasText: "Edit this collapsed message." })
  ).toBeHidden();

  // Expand again
  await userStep.getByRole("button").first().click();
  await expect(
    page.locator('[data-step-kind="user"] p', { hasText: "Edit this collapsed message." })
  ).toBeVisible();

  // Now the edit button is accessible
  await userStep.getByRole("button", { name: "Edit message" }).click();
  await expect(page.getByRole("textbox", { name: "Edit message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
});

test("submits an edited previous user message and replaces the later conversation tail", async ({
  page,
}) => {
  const now = "2026-03-20T11:00:00.000Z";
  await seedConversationState(
    page,
    [
      {
        id: "conversation-1",
        title: "Original prompt",
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
        activeToolIds: [],
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
    ],
    "conversation-1"
  );

  await page.goto("/");

  await page.getByRole("button", { name: "Edit message" }).first().click();

  const editInput = page.getByRole("textbox", { name: "Edit message" });
  await editInput.fill("Edited prompt");
  await editInput.press("Enter");

  await expect(page.locator('[data-step-kind="user"] p', { hasText: "Edited prompt" })).toBeVisible();
  await expect(page.getByText("Old reply")).toHaveCount(0);
  await expect(page.getByText("Later prompt")).toHaveCount(0);
  await expect(page.getByText("This is a streamed answer from the mocked Ollama endpoint.")).toBeVisible();
});

test("regenerates an assistant response and replaces the later conversation tail", async ({
  page,
}) => {
  const now = "2026-03-20T11:00:00.000Z";
  await seedConversationState(
    page,
    [
      {
        id: "conversation-1",
        title: "Original prompt",
        titleEdited: false,
        model: "qwen3:latest",
        systemPrompt: "",
        createdAt: now,
        updatedAt: now,
        availableTools: [],
        activeToolIds: [],
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
    ],
    "conversation-1"
  );

  await page.goto("/");

  await page.getByRole("button", { name: "Regenerate response" }).click();

  await expect(page.getByText("Old reply")).toHaveCount(0);
  await expect(page.getByText("Prior reasoning")).toHaveCount(0);
  await expect(page.getByText("Later prompt")).toHaveCount(0);
  await expect(page.getByText("This is a streamed answer from the mocked Ollama endpoint.")).toBeVisible();
});

test("regenerates a newly created assistant response and replaces it with a fresh response", async ({
  page,
}) => {
  const handlers = [
    makeMockWsHandler("First reasoning trace.", "First generated answer."),
    makeMockWsHandler("Second reasoning trace.", "Second generated answer."),
  ];
  let chatCallCount = 0;

  wsChatHandler = (message, ws) => {
    const handler = handlers[Math.min(chatCallCount, handlers.length - 1)];
    chatCallCount += 1;
    handler(message, ws);
  };

  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "User Prompt" });
  await prompt.fill("Regenerate this answer.");
  await prompt.press("Enter");

  await expect(page.getByText("First reasoning trace.")).toBeVisible();
  await expect(page.getByText("First generated answer.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate response" })).toBeVisible();
  await expect.poll(() => chatCallCount).toBe(1);

  await page.getByRole("button", { name: "Regenerate response" }).click();

  await expect(page.getByText("First reasoning trace.")).toHaveCount(0);
  await expect(page.getByText("First generated answer.")).toHaveCount(0);
  await expect(page.getByText("Second reasoning trace.")).toBeVisible();
  await expect(page.getByText("Second generated answer.")).toBeVisible();
  await expect.poll(() => chatCallCount).toBe(2);
});

test("lets the user open the right sidebar and see tool definitions", async ({ page }) => {
  await page.goto("/");

  // Open the right sidebar
  await page.locator('button[aria-label="Expand tools sidebar"]').click();
  // Expand the Tools section
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  // Expand the built-in subsection
  await page.getByText("built-in").click();
  await expect(page.getByText("web_search").first()).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: /web_search/i,
    })
  ).toBeVisible();

  // Close the right sidebar
  await page.locator('button[aria-label="Collapse tools sidebar"]').click();

  // Re-open and verify tools are still there
  await page.locator('button[aria-label="Expand tools sidebar"]').click();
  await expect(page.getByText("web_search").first()).toBeVisible();
});

test("streams a mocked assistant response without rendering derived tool steps", async ({ page }) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "User Prompt" });
  await prompt.fill("Show me a mocked streamed answer with reasoning and tool calls.");
  await prompt.press("Enter");

  await expect(
    page.getByText("Show me a mocked streamed answer with reasoning and tool calls.")
  ).toBeVisible();
  await expect(page.getByText("I should show my reasoning as a separate step.")).toBeVisible();
  await expect(page.getByText("Requested web_search")).toHaveCount(0);
  await expect(
    page.getByText("This is a streamed answer from the mocked Ollama endpoint.")
  ).toBeVisible();
});

test("persists conversations created through the composer across reloads", async ({ page }) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "User Prompt" });
  await prompt.fill("Create a persisted conversation title from this prompt.");
  await prompt.press("Enter");

  await expect(
    page.getByText("Create a persisted conversation title from t").first()
  ).toBeVisible();
  // Reload only once the streamed answer is persisted too; reloading mid-stream legitimately drops it.
  await page.waitForFunction(() => {
    const raw = window.localStorage.getItem("ollamable.conversations");
    return (
      raw?.includes("Create a persisted conversation title from this prompt.") &&
      raw.includes("This is a streamed answer from the mocked Ollama endpoint.")
    );
  });

  await page.reload();

  await expect(
    page.getByText("Create a persisted conversation title from t").first()
  ).toBeVisible();
  await expect(
    page.getByText("This is a streamed answer from the mocked Ollama endpoint.")
  ).toBeVisible();
});

test("allows editing the conversation title by clicking on it in the sidebar and persists the custom name", async ({
  page,
}) => {
  // Seed a conversation that has user steps so it shows in the sidebar.
  const now = "2026-03-20T11:00:00.000Z";
  await seedConversationState(
    page,
    [
      {
        id: "conversation-1",
        title: "Initial title",
        titleEdited: false,
        model: "qwen3:latest",
        systemPrompt: "",
        createdAt: now,
        updatedAt: now,
        availableTools: [],
        activeToolIds: [],
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
            content: "Hello world",
            createdAt: now,
            expanded: true,
          },
          {
            id: "assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Hi there!",
            createdAt: now,
            expanded: true,
          },
        ],
      },
    ],
    "conversation-1"
  );

  await page.goto("/");

  // Wait for the sidebar title to appear
  await expect(page.getByText("Initial title").first()).toBeVisible();

  // Click on the title text in the sidebar to enter edit mode.
  await page.getByText("Initial title").click();

  // The title becomes a raw <input> (autofocused) with the current value.
  const titleInput = page.locator("input[style]").first();
  await expect(titleInput).toBeVisible();
  await titleInput.fill("Pinned custom conversation");
  await titleInput.press("Enter");

  await page.waitForFunction(() => {
    const raw = window.localStorage.getItem("ollamable.conversations");
    return raw?.includes('"title":"Pinned custom conversation"') && raw.includes('"titleEdited":true');
  });

  await expect(page.getByText("Pinned custom conversation").first()).toBeVisible();

  await page.reload();

  await expect(page.getByText("Pinned custom conversation").first()).toBeVisible();
});

test("keeps the composer textarea usable when the prompt input grows large", async ({ page }) => {
  await page.goto("/");

  const promptInput = page.getByRole("textbox", { name: "User Prompt" });
  const longPrompt = Array.from(
    { length: 80 },
    (_, index) => `Line ${index + 1} prompt content.`
  ).join("\n");

  await promptInput.fill(longPrompt);

  const promptMetrics = await promptInput.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  const viewport = page.viewportSize();

  expect(promptMetrics.scrollHeight).toBeGreaterThan(promptMetrics.clientHeight);
  expect(promptMetrics.overflowY).toBe("auto");
  expect(viewport).not.toBeNull();
  // The textarea should remain within the viewport.
  const promptBox = await promptInput.boundingBox();
  expect(promptBox).not.toBeNull();
  expect(promptBox!.y + promptBox!.height).toBeLessThanOrEqual(viewport!.height);
});

// ── System prompt examples ────────────────────────────────────────────

test("shows system prompt example chips on a fresh conversation", async ({ page }) => {
  await page.goto("/");

  const examples = page.getByTestId("system-prompt-examples");
  await expect(examples).toBeVisible();
  await expect(examples.getByText("Helpful Assistant")).toBeVisible();
  await expect(examples.getByText("Code Reviewer")).toBeVisible();
  await expect(examples.getByText("Socratic Tutor")).toBeVisible();
  await expect(examples.getByText("Creative Writer")).toBeVisible();
});

test("clicking an example chip fills the system prompt", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("example-code-reviewer").click();

  const systemPrompt = page.getByRole("textbox", { name: "System prompt" });
  await expect(systemPrompt).toHaveValue(/senior software engineer/);
});

test("example chips disappear after the user sends a message", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("system-prompt-examples")).toBeVisible();

  const prompt = page.getByRole("textbox", { name: "User Prompt" });
  await prompt.fill("Hello");
  await prompt.press("Enter");

  await expect(page.getByTestId("system-prompt-examples")).toHaveCount(0);
});

test("toggling 'Show examples' off in client settings hides the example chips", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("system-prompt-examples")).toBeVisible();

  // Open right sidebar and Client section
  await page.locator('button[aria-label="Expand tools sidebar"]').click();
  await page.getByText("Client").click();
  await page.getByText("Show examples").click();

  await expect(page.getByTestId("system-prompt-examples")).toHaveCount(0);

  // Toggle back on
  await page.getByText("Show examples").click();
  await expect(page.getByTestId("system-prompt-examples")).toBeVisible();
});

test("'Show examples' setting persists across reloads", async ({ page }) => {
  await page.goto("/");

  // Disable examples
  await page.locator('button[aria-label="Expand tools sidebar"]').click();
  await page.getByText("Client").click();
  await page.getByText("Show examples").click();
  await expect(page.getByTestId("system-prompt-examples")).toHaveCount(0);

  await page.reload();

  await expect(page.getByTestId("system-prompt-examples")).toHaveCount(0);
});

// ── Collapse-by-default client settings ──────────────────────────────

test("reasoning steps stay collapsed after streaming when collapseReasoning is enabled", async ({ page }) => {
  // Pre-set the sidebar state with collapseReasoning enabled
  await page.addInitScript(() => {
    const state = JSON.parse(
      window.localStorage.getItem("ollamable.sidebarState") || "{}"
    );
    window.localStorage.setItem(
      "ollamable.sidebarState",
      JSON.stringify({ ...state, collapseReasoning: true })
    );
  });

  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "User Prompt" });
  await prompt.fill("Trigger a response with reasoning.");
  await prompt.press("Enter");

  // Wait for the assistant response to appear (stream complete)
  await expect(
    page.getByText("This is a streamed answer from the mocked Ollama endpoint.")
  ).toBeVisible();

  // The reasoning step card should exist but its content should be hidden (collapsed)
  await expect(page.locator('[data-step-kind="reasoning"]')).toBeVisible();
  await expect(
    page.locator('[data-step-kind="reasoning"]').getByText("I should show my reasoning as a separate step.")
  ).toBeHidden();
});

// ── Delete last message ─────────────────────────────────────────────

test("deleting the last assistant message removes only the response, keeps the user message and earlier exchanges", async ({
  page,
}) => {
  const now = "2026-03-20T11:00:00.000Z";
  await seedConversationState(
    page,
    [
      {
        id: "conversation-1",
        title: "Delete test",
        titleEdited: false,
        model: "qwen3:latest",
        systemPrompt: "",
        createdAt: now,
        updatedAt: now,
        availableTools: [],
        activeToolIds: [],
        steps: [
          { id: "system-1", kind: "system", title: "System Prompt", content: "", createdAt: now, expanded: true },
          { id: "user-1", kind: "user", title: "User", content: "First question", createdAt: now, expanded: true },
          { id: "reasoning-1", kind: "reasoning", title: "Reasoning", content: "Thinking about first", createdAt: now, expanded: true },
          { id: "assistant-1", kind: "assistant", title: "Assistant", content: "First answer", createdAt: now, expanded: true },
          { id: "user-2", kind: "user", title: "User", content: "Second question", createdAt: now, expanded: true },
          { id: "reasoning-2", kind: "reasoning", title: "Reasoning", content: "Thinking about second", createdAt: now, expanded: true },
          { id: "assistant-2", kind: "assistant", title: "Assistant", content: "Second answer", createdAt: now, expanded: true },
        ],
      },
    ],
    "conversation-1"
  );

  await page.goto("/");

  // Both exchanges should be visible
  await expect(page.getByText("First question")).toBeVisible();
  await expect(page.getByText("First answer")).toBeVisible();
  await expect(page.getByText("Second question")).toBeVisible();
  await expect(page.getByText("Second answer")).toBeVisible();

  // The delete button should appear on the last assistant step
  const lastAssistant = page.locator('[data-step-kind="assistant"]').last();
  await lastAssistant.getByRole("button", { name: "Delete message" }).click();

  // The second response (reasoning + assistant) should be removed
  await expect(page.getByText("Second answer")).toHaveCount(0);
  await expect(page.getByText("Thinking about second")).toHaveCount(0);

  // The user message that triggered it should still be there
  await expect(page.getByText("Second question")).toBeVisible();

  // The first exchange should be untouched
  await expect(page.getByText("First question")).toBeVisible();
  await expect(page.getByText("First answer")).toBeVisible();

  // The conversation should still be in the sidebar
  await expect(page.getByText("Delete test").first()).toBeVisible();
});

test("deleting the last user message (no assistant response) removes only that message", async ({
  page,
}) => {
  const now = "2026-03-20T11:00:00.000Z";
  await seedConversationState(
    page,
    [
      {
        id: "conversation-1",
        title: "Delete user test",
        titleEdited: false,
        model: "qwen3:latest",
        systemPrompt: "",
        createdAt: now,
        updatedAt: now,
        availableTools: [],
        activeToolIds: [],
        steps: [
          { id: "system-1", kind: "system", title: "System Prompt", content: "", createdAt: now, expanded: true },
          { id: "user-1", kind: "user", title: "User", content: "First question", createdAt: now, expanded: true },
          { id: "assistant-1", kind: "assistant", title: "Assistant", content: "First answer", createdAt: now, expanded: true },
          { id: "user-2", kind: "user", title: "User", content: "Pending question", createdAt: now, expanded: true },
        ],
      },
    ],
    "conversation-1"
  );

  await page.goto("/");

  // The pending user message should have a delete button
  const lastUser = page.locator('[data-step-kind="user"]').last();
  await lastUser.getByRole("button", { name: "Delete message" }).click();

  // The pending user message should be gone
  await expect(page.getByText("Pending question")).toHaveCount(0);

  // The first exchange should remain
  await expect(page.getByText("First question")).toBeVisible();
  await expect(page.getByText("First answer")).toBeVisible();

  // Conversation still in sidebar
  await expect(page.getByText("Delete user test").first()).toBeVisible();
});
