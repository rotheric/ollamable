import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

/**
 * E2E tests for the WebSocket backend harness features.
 *
 * These tests use Playwright's `page.routeWebSocket` to intercept the
 * browser's WebSocket connection to ws://localhost:3001 and script
 * server messages.  This lets the frontend take the WebSocket code path
 * (wsConnected === true) rather than the direct-Ollama fallback — with
 * no real server process needed.
 *
 * The Ollama /api/chat route is NOT mocked at the browser level so
 * chat only succeeds when it flows through the WebSocket path.
 */

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

// ── Per-test WebSocket handler ───────────────────────────────────────

type WsHandler = (message: Record<string, unknown>, server: WebSocketRoute) => void;

let wsHandler: WsHandler | null = null;
let wsServer: WebSocketRoute | null = null;

test.beforeEach(async ({ page }) => {
  wsHandler = null;
  wsServer = null;

  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("ollamable.e2e.backend.init")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("ollamable.e2e.backend.init", "1");
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

  // Intercept WebSocket connection to our mock backend.
  await page.routeWebSocket(/ws/, (ws) => {
    wsServer = ws;
    ws.onMessage((raw) => {
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        wsHandler?.(data, ws);
      } catch {
        // ignore malformed
      }
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

async function closeToolsDrawer(_page: Page) {
  // No-op: the tools modal no longer exists.
}

/** Wait until the WebSocket route has been connected by the browser. */
async function waitForWsConnection() {
  await expect
    .poll(() => wsServer !== null, { timeout: 5_000, message: "waiting for WS route" })
    .toBe(true);
}

function send(ws: WebSocketRoute, msg: Record<string, unknown>) {
  ws.send(JSON.stringify(msg));
}

// ── Tests ────────────────────────────────────────────────────────────

test("streams an assistant response through the WebSocket backend", async ({ page }) => {
  const chatSendReceived = new Promise<void>((resolve) => {
    wsHandler = (data, ws) => {
      if (data.type === "chat.send") {
        const conversationId = data.conversationId as string;

        send(ws, {
          type: "chat.delta",
          conversationId,
          requestId: data.requestId,
          steps: [
            {
              id: "ws-assistant-1",
              kind: "assistant",
              title: "Assistant",
              content: "Hello from the WebSocket backend!",
              createdAt: new Date().toISOString(),
              expanded: true,
            },
          ],
        });

        send(ws, {
          type: "chat.done",
          conversationId,
          requestId: data.requestId,
          steps: [
            {
              id: "ws-assistant-1",
              kind: "assistant",
              title: "Assistant",
              content: "Hello from the WebSocket backend!",
              createdAt: new Date().toISOString(),
              expanded: true,
            },
          ],
        });

        resolve();
      }
    };
  });

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Test backend prompt");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  await chatSendReceived;

  await expect(page.getByText("Hello from the WebSocket backend!")).toBeVisible();
  await expect(page.locator('[data-step-kind="assistant"]')).toBeVisible();
});

test("renders reasoning and assistant steps from the backend", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      send(ws, {
        type: "chat.delta",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-reasoning-1",
            kind: "reasoning",
            title: "Reasoning",
            content: "Let me think about this carefully...",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
          {
            id: "ws-assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Here is my answer via backend.",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });

      send(ws, {
        type: "chat.done",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-reasoning-1",
            kind: "reasoning",
            title: "Reasoning",
            content: "Let me think about this carefully...",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
          {
            id: "ws-assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Here is my answer via backend.",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Reason for me");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  await expect(page.getByText("Let me think about this carefully...")).toBeVisible();
  await expect(page.getByText("Here is my answer via backend.")).toBeVisible();
  await expect(page.locator('[data-step-kind="reasoning"]')).toBeVisible();
  await expect(page.locator('[data-step-kind="assistant"]')).toBeVisible();
});

test("renders inline meta event cards from the backend", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      // Emit meta events before the response
      send(ws, {
        type: "meta.event",
        conversationId,
        requestId: data.requestId,
        event: {
          id: "meta-1",
          kind: "search_start",
          title: "Web Search",
          detail: "",
          data: { query: "test query" },
          timestamp: new Date().toISOString(),
        },
      });

      send(ws, {
        type: "meta.event",
        conversationId,
        requestId: data.requestId,
        event: {
          id: "meta-2",
          kind: "search_result",
          title: "Search Results",
          detail: "3 result(s) in 142ms",
          data: { results: [{ title: "Example", url: "https://example.com", snippet: "A snippet" }], durationMs: 142 },
          timestamp: new Date().toISOString(),
          durationMs: 142,
        },
      });

      // Then send the final assistant response
      send(ws, {
        type: "chat.delta",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Search results are in.",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });

      send(ws, {
        type: "chat.done",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Search results are in.",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Search something");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  // Meta events render as step cards with kind "meta"
  await expect(page.locator('[data-step-kind="meta"]').first()).toBeVisible();
  await expect(page.getByText("search start")).toBeVisible();

  // The meta event data is rendered as JSON inside the step card
  await expect(page.getByText('"test query"').first()).toBeVisible();

  // Final response should also be visible
  await expect(page.getByText("Search results are in.")).toBeVisible();
});

test("renders meta events with duration badges", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      send(ws, {
        type: "meta.event",
        conversationId,
        requestId: data.requestId,
        event: {
          id: "meta-duration-1",
          kind: "mcp_result",
          title: "MCP Result",
          detail: "Tool completed in 350ms",
          data: { tool: "test_tool" },
          timestamp: new Date().toISOString(),
          durationMs: 350,
        },
      });

      send(ws, {
        type: "chat.done",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Done with MCP call.",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("MCP test");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  // The meta step header shows the kind and tool name
  await expect(page.getByText("Server Result: test_tool")).toBeVisible();
  // Duration is shown in the footer
  await expect(page.getByText("350ms", { exact: true })).toBeVisible();
});

test("handles chat.error from the backend and displays an error message", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      send(ws, {
        type: "chat.error",
        conversationId,
        requestId: data.requestId,
        message: "Ollama request failed: 503",
      });
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Trigger an error");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  await expect(page.getByText("Failed to stream from backend: Ollama request failed: 503")).toBeVisible();
});

test("sends chat.stop when the user clicks stop during streaming", async ({ page }) => {
  let chatStopReceived = false;

  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      // Send a delta but do NOT send chat.done — simulating an ongoing stream
      send(ws, {
        type: "chat.delta",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-assistant-partial",
            kind: "assistant",
            title: "Assistant",
            content: "Partial response still streaming...",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });
    }

    if (data.type === "chat.stop") {
      chatStopReceived = true;
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Long running request");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  // Wait for the partial content to appear (proves the stream started)
  await expect(page.getByText("Partial response still streaming...")).toBeVisible();

  // Click the stop button
  await page.getByRole("button", { name: "Stop" }).click();

  await expect.poll(() => chatStopReceived, { timeout: 3_000 }).toBe(true);
  await expect(page.getByText("Generation stopped.")).toBeVisible();
});

test("disconnect ends generation, retains authentic partial text, and permits manual retry after reconnect", async ({ page }) => {
  let requests = 0;
  wsHandler = (data, ws) => {
    if (data.type !== "chat.send") return;
    requests++;
    send(ws, {
      type: requests === 1 ? "chat.delta" : "chat.done",
      conversationId: data.conversationId,
      requestId: data.requestId,
      steps: [{ id: `response-${requests}`, kind: "assistant", title: "Assistant",
        content: requests === 1 ? "Authentic partial response" : "Manual retry completed",
        createdAt: new Date().toISOString() }],
    });
  };
  await page.goto("/");
  await waitForWsConnection();
  await page.getByRole("textbox", { name: "User Prompt" }).fill("Interrupt this request");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");
  await expect(page.getByText("Authentic partial response", { exact: true })).toBeVisible();
  const oldSocket = wsServer!;
  oldSocket.close({ code: 1011, reason: "test disconnect" });
  await expect(page.getByText(/Backend connection lost/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.getByText("Authentic partial response", { exact: true })).toBeVisible();
  await expect.poll(() => wsServer !== oldSocket).toBe(true);
  expect(requests).toBe(1); // reconnect cannot replay an interrupted generation
  await page.getByRole("textbox", { name: "User Prompt" }).fill("Retry manually");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");
  await expect(page.getByText("Manual retry completed", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Authentic partial response", { exact: true })).toBeVisible();
});

test("forwards the correct model and steps in chat.send", async ({ page }) => {
  let receivedPayload: Record<string, unknown> | null = null;

  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      receivedPayload = data;
      const conversationId = data.conversationId as string;

      send(ws, {
        type: "chat.done",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Ack.",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  // Set a system prompt
  const systemPrompt = page.getByRole("textbox", { name: "System prompt", exact: true });
  await systemPrompt.fill("You are a test assistant.");

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Verify payload");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  await expect(page.getByText("Ack.")).toBeVisible();

  expect(receivedPayload).not.toBeNull();
  expect(receivedPayload!.type).toBe("chat.send");
  expect(receivedPayload!.model).toBe("qwen3:latest");
  expect(receivedPayload!.conversationId).toBeTruthy();
  expect(Array.isArray(receivedPayload!.steps)).toBe(true);

  const steps = receivedPayload!.steps as Array<{ kind: string; content: string }>;

  // Should include system prompt and user message
  const systemStep = steps.find((s) => s.kind === "system");
  const userStep = steps.find((s) => s.kind === "user" && s.content === "Verify payload");
  expect(systemStep?.content).toBe("You are a test assistant.");
  expect(userStep).toBeTruthy();
});

test("sends active tool definitions in chat.send when tools are enabled", async ({ page }) => {
  let receivedPayload: Record<string, unknown> | null = null;

  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      receivedPayload = data;
      const conversationId = data.conversationId as string;

      send(ws, {
        type: "chat.done",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Tools received.",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });
    }
  };

  await page.goto("/");
  await waitForWsConnection();

  // Open the right sidebar and enable web_search
  await page.getByRole("button", { name: "Expand tools sidebar" }).click();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("built-in").click();
  await page.getByRole("checkbox", { name: /web_search/i }).check();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Use tools");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  await expect(page.getByText("Tools received.")).toBeVisible();

  expect(receivedPayload).not.toBeNull();
  const tools = receivedPayload!.tools as Array<{ name: string }>;
  expect(tools.length).toBeGreaterThan(0);
  expect(tools.some((t) => t.name === "web_search")).toBe(true);
});

test("renders tool call and tool result steps from the backend tool loop", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      // Simulate the server tool loop: tool_call → tool_result → final assistant
      send(ws, {
        type: "chat.delta",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-tool-call-1",
            kind: "tool_call",
            title: "Tool Call",
            content: "Requested web_search",
            createdAt: new Date().toISOString(),
            expanded: true,
            toolCall: {
              name: "web_search",
              arguments: { query: "test query from tool loop" },
            },
          },
        ],
      });

      // After tool execution, send the full result set
      send(ws, {
        type: "chat.done",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-tool-call-1",
            kind: "tool_call",
            title: "Tool Call",
            content: "Requested web_search",
            createdAt: new Date().toISOString(),
            expanded: true,
            toolCall: {
              name: "web_search",
              arguments: { query: "test query from tool loop" },
            },
          },
          {
            id: "ws-tool-result-1",
            kind: "tool_result",
            title: "Result: web_search",
            content: '{"query":"test query from tool loop","results":[{"title":"Example","url":"https://example.com"}]}',
            createdAt: new Date().toISOString(),
            expanded: true,
            toolResult: { name: "web_search" },
          },
          {
            id: "ws-assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: "Based on the search results, here is the answer.",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Search and answer");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  // The final assistant text should be visible
  await expect(page.getByText("Based on the search results, here is the answer.")).toBeVisible();

  const transcript = page.getByRole("region", { name: "Conversation transcript" });
  await expect(transcript.locator('[data-step-kind="tool_call"]')).toHaveCount(1);
  await expect(transcript.locator('[data-step-kind="tool_result"]')).toHaveCount(1);
  // Protocol activity keeps its chronological position between the prompt and the answer.
  const kinds = await transcript.locator("[data-step-kind]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-step-kind")));
  expect(kinds).toEqual(["user", "tool_call", "tool_result", "assistant"]);
});

test("persists backend-routed conversation steps across page reload", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      send(ws, {
        type: "chat.done",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-persist-assistant",
            kind: "assistant",
            title: "Assistant",
            content: "This response should persist after reload.",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Persistence test");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  await expect(page.getByText("This response should persist after reload.")).toBeVisible();

  // Wait for localStorage to be updated
  await page.waitForFunction(() => {
    const raw = window.localStorage.getItem("ollamable.conversations");
    return raw?.includes("This response should persist after reload.");
  });

  await page.reload();
  await closeToolsDrawer(page);

  await expect(page.getByText("This response should persist after reload.")).toBeVisible();
  await expect(
    page.locator('[data-step-kind="user"] p', { hasText: "Persistence test" })
  ).toBeVisible();
});

test("handles multiple sequential delta messages that build up the response", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      // First delta — partial content
      send(ws, {
        type: "chat.delta",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-incremental-1",
            kind: "assistant",
            title: "Assistant",
            content: "First chunk. ",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });

      // Second delta — more content (server sends full accumulated text each time)
      setTimeout(() => {
        send(ws, {
          type: "chat.delta",
          conversationId,
          requestId: data.requestId,
          steps: [
            {
              id: "ws-incremental-1",
              kind: "assistant",
              title: "Assistant",
              content: "First chunk. Second chunk. ",
              createdAt: new Date().toISOString(),
              expanded: true,
            },
          ],
        });
      }, 50);

      // Final done
      setTimeout(() => {
        send(ws, {
          type: "chat.done",
          conversationId,
          requestId: data.requestId,
          steps: [
            {
              id: "ws-incremental-1",
              kind: "assistant",
              title: "Assistant",
              content: "First chunk. Second chunk. Final chunk.",
              createdAt: new Date().toISOString(),
              expanded: true,
            },
          ],
        });
      }, 100);
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Stream incrementally");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  await expect(page.getByText("First chunk. Second chunk. Final chunk.")).toBeVisible();
});

test("displays input/output tokens and stop reason on assistant steps", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      send(ws, {
        type: "chat.delta",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-usage-assistant",
            kind: "assistant",
            title: "Assistant",
            content: "Response with usage stats.",
            createdAt: new Date().toISOString(),
            expanded: true,
          },
        ],
      });

      send(ws, {
        type: "chat.done",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-usage-assistant",
            kind: "assistant",
            title: "Assistant",
            content: "Response with usage stats.",
            createdAt: new Date().toISOString(),
            expanded: true,
            usage: {
              inputTokens: 42,
              outputTokens: 128,
              stopReason: "stop",
            },
          },
        ],
      });
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Show me usage");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  await expect(page.getByText("Response with usage stats.")).toBeVisible();

  // The secondary text should display token counts and stop reason
  const assistantStep = page.locator('[data-step-kind="assistant"]');
  await expect(assistantStep.getByText("in: 42")).toBeVisible();
  await expect(assistantStep.getByText("out: 128")).toBeVisible();
  await expect(assistantStep.getByText("stop: stop")).toBeVisible();
});

test("displays partial usage data when only some fields are present", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      send(ws, {
        type: "chat.done",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-partial-usage",
            kind: "assistant",
            title: "Assistant",
            content: "Only output tokens.",
            createdAt: new Date().toISOString(),
            expanded: true,
            usage: {
              outputTokens: 55,
            },
          },
        ],
      });
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Partial usage");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  await expect(page.getByText("Only output tokens.")).toBeVisible();

  const assistantStep = page.locator('[data-step-kind="assistant"]');
  await expect(assistantStep.getByText("out: 55")).toBeVisible();
  // Should not show "in:" since inputTokens was not provided
  await expect(assistantStep.getByText(/in:/)).toHaveCount(0);
});

test("persists usage data across page reload", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type === "chat.send") {
      const conversationId = data.conversationId as string;

      send(ws, {
        type: "chat.done",
        conversationId,
        requestId: data.requestId,
        steps: [
          {
            id: "ws-persist-usage",
            kind: "assistant",
            title: "Assistant",
            content: "Persisted usage response.",
            createdAt: new Date().toISOString(),
            expanded: true,
            usage: {
              inputTokens: 100,
              outputTokens: 200,
              stopReason: "length",
            },
          },
        ],
      });
    }
  };

  await page.goto("/");
  await closeToolsDrawer(page);
  await waitForWsConnection();

  await page.getByRole("textbox", { name: "User Prompt" }).fill("Persist usage test");
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");

  await expect(page.getByText("Persisted usage response.")).toBeVisible();

  // Wait for localStorage persistence
  await page.waitForFunction(() => {
    const raw = window.localStorage.getItem("ollamable.conversations");
    return raw?.includes('"inputTokens":100');
  });

  await page.reload();
  await closeToolsDrawer(page);

  // Usage data should survive the reload
  const assistantStep = page.locator('[data-step-kind="assistant"]');
  await expect(assistantStep.getByText("in: 100")).toBeVisible();
  await expect(assistantStep.getByText("out: 200")).toBeVisible();
  await expect(assistantStep.getByText("stop: length")).toBeVisible();
});

for (const display of ["markdown", "plain", "tokens"] as const) {
  test(`keeps authentic assistant prose alongside tool calls in ${display} mode`, async ({ page }) => {
    await page.addInitScript((mode) => {
      localStorage.setItem("ollamable.sidebarState", JSON.stringify({ renderMarkdown: mode === "markdown", showTokens: mode === "tokens" }));
    }, display);
    wsHandler = (data, ws) => {
      if (data.type !== "chat.send") return;
      const step = {
        id: "mixed-response", kind: "assistant", title: "Assistant", expanded: true,
        content: "Authentic **assistant explanation**", createdAt: new Date().toISOString(),
        toolCalls: [{ id: "mixed-call", name: "inspect_example", arguments: { query: "distinctive query" } }],
      };
      send(ws, { type: "chat.done", conversationId: data.conversationId, requestId: data.requestId, steps: [step] });
    };
    await page.goto("/");
    await waitForWsConnection();
    const prompt = page.getByRole("textbox", { name: "User Prompt" });
    await prompt.fill("Explain before calling a tool");
    await prompt.press("Enter");
    const assistant = page.locator('[data-step-kind="assistant"]');
    await expect(assistant).toContainText("Authentic");
    await expect(assistant).toContainText("assistant explanation");
    const call = page.locator('[data-step-kind="tool_call"]');
    await expect(call).toContainText("inspect_example");
    await expect(call).toContainText("distinctive query");
    await expect(assistant).not.toContainText("inspect_example");
    if (display === "markdown") await expect(assistant.locator("strong")).toHaveText("assistant explanation");
    if (display === "tokens") await expect(assistant.getByTestId("token-text")).toContainText("Authentic **assistant explanation**");
  });
}

test("tool-only responses and legacy saved calls stay outside assistant messages", async ({ page }) => {
  wsHandler = (data, ws) => {
    if (data.type !== "chat.send") return;
    const createdAt = new Date().toISOString();
    send(ws, { type: "chat.done", conversationId: data.conversationId, requestId: data.requestId, steps: [
      { id: "protocol-call", kind: "tool_call", title: "Tool Call", content: "", createdAt, expanded: true,
        toolCall: { id: "call-1", name: "inspect_example", arguments: { query: "only a tool" } }, usage: { inputTokens: 17, outputTokens: 9 } },
      { id: "protocol-result", kind: "tool_result", title: "Result", content: "Inspection finished", createdAt, expanded: true,
        toolResult: { id: "call-1", name: "inspect_example" } },
    ] });
  };
  await page.goto("/");
  await waitForWsConnection();
  const prompt = page.getByRole("textbox", { name: "User Prompt" });
  await prompt.fill("Inspect without prose");
  await prompt.press("Enter");
  await expect(page.locator('[data-step-kind="tool_call"]')).toContainText("only a tool");
  await expect(page.locator('[data-step-kind="tool_result"]')).toContainText("Inspection finished");
  await expect(page.locator('[data-step-kind="assistant"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Regenerate response" })).toHaveCount(0);
  await page.waitForFunction(() => localStorage.getItem("ollamable.conversations")?.includes("protocol-result"));
  // Simulate an existing installation's merged tool-only assistant record.
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("ollamable.conversations")!);
    for (const conversation of saved) for (const step of conversation.steps) {
      if (step.id !== "protocol-call") continue;
      step.kind = "assistant";
      step.toolCalls = [step.toolCall];
      delete step.toolCall;
    }
    localStorage.setItem("ollamable.conversations", JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.locator('[data-step-kind="tool_call"]')).toContainText("only a tool");
  await expect(page.locator('[data-step-kind="tool_call"]')).toContainText("out: 9");
  await expect(page.locator('[data-step-kind="assistant"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Regenerate response" })).toHaveCount(0);
  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem("ollamable.conversations")!);
    return saved.some((c: { steps: Array<{ kind: string; toolCalls?: unknown[] }> }) =>
      c.steps.some((s) => s.kind === "tool_call") && c.steps.every((s) => !s.toolCalls));
  });
});

for (const failure of ["quota", "unavailable"] as const) {
  test(`keeps chat usable and warns when persistence is ${failure}`, async ({ page }) => {
    if (failure === "unavailable") await page.setViewportSize({ width: 700, height: 900 });
    await page.addInitScript((mode) => {
      if (mode === "unavailable") {
        Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Denied", "SecurityError"); } });
      } else {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key.startsWith("ollamable.")) throw new DOMException("Full", "QuotaExceededError");
          return original.call(this, key, value);
        };
      }
    }, failure);
    wsHandler = (data, ws) => {
      if (data.type !== "chat.send") return;
      send(ws, { type: "chat.done", conversationId: data.conversationId, requestId: data.requestId, steps: [
        { id: "unsaved-answer", kind: "assistant", title: "Assistant", content: "Still usable despite storage failure", createdAt: new Date().toISOString(), expanded: true },
      ] });
    };
    await page.goto("/");
    await waitForWsConnection();
    await expect(page.getByRole("alert").filter({ hasText: "Some changes are not saved" })).toBeVisible();
    const prompt = page.getByRole("textbox", { name: "User Prompt" });
    await prompt.fill("Keep working in this tab");
    await prompt.press("Enter");
    await expect(page.getByText("Still usable despite storage failure", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Some changes are not saved" })).toBeVisible();
  });
}
