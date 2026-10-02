import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

/**
 * Browser coverage for the token view ("Show tokens" in the Client
 * settings). The backend is scripted over an intercepted WebSocket: it
 * answers a chat with an assistant step that carries its stream token
 * boundaries, and answers tokenize requests for the user's own text.
 */

const mockModels = {
  models: [
    { name: "qwen3:latest", provider: "ollama", providerName: "Ollama", family: "qwen", families: ["qwen"], parameterSize: "8B" },
  ],
};

const ASSISTANT_TOKENS = ["Token", "izers", " split", " text", "."];
/** How the scripted tokenizer splits any text: after each word. */
function tokenize(text: string): string[] {
  return text.match(/\s*\S+/g) ?? [];
}

let tokenizeRequests: Array<{ text: string; model: string; provider?: string }> = [];

test.beforeEach(async ({ page }) => {
  tokenizeRequests = [];

  await page.addInitScript(() => {
    // Start each test clean, but keep what the app stored across a reload within the test.
    if (!window.sessionStorage.getItem("ollamable.e2e.token-view.init")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("ollamable.e2e.token-view.init", "1");
    }
    window.localStorage.setItem("ollamable.tourCompleted", "true");
  });

  await page.route("**/models", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockModels) }));
  await page.route("**/tools", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tools: [] }) }));

  await page.routeWebSocket(/ws/, (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      const data = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (data.type === "chat.send") {
        ws.send(JSON.stringify({
          type: "chat.done",
          conversationId: data.conversationId,
          requestId: data.requestId,
          steps: [{
            id: "assistant-1",
            kind: "assistant",
            title: "Assistant",
            content: ASSISTANT_TOKENS.join(""),
            contentTokens: ASSISTANT_TOKENS,
            createdAt: new Date().toISOString(),
            expanded: true,
          }],
        }));
      } else if (data.type === "tokenize") {
        const text = data.text as string;
        tokenizeRequests.push({ text, model: data.model as string, provider: data.provider as string | undefined });
        const tokens = tokenize(text);
        ws.send(JSON.stringify({ type: "tokenize.result", requestId: data.requestId, tokens, tokenIds: tokens.map((_, i) => i) }));
      }
    });
  });
});

async function sendPrompt(page: Page, prompt: string) {
  await page.getByRole("textbox", { name: "User Prompt" }).fill(prompt);
  await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");
  await expect(page.locator('[data-step-kind="assistant"]')).toBeVisible();
}

async function toggleShowTokens(page: Page) {
  await page.getByText("Show tokens").click();
}

async function openClientSettings(page: Page) {
  await page.locator('button[aria-label="Expand tools sidebar"]').click();
  await page.getByText("Client").click();
}

test("shows token boundaries for the transcript and restores the normal view when switched off", async ({ page }) => {
  await page.goto("/");
  await sendPrompt(page, "Show me tokens");

  const assistant = page.locator('[data-step-kind="assistant"]');
  const user = page.locator('[data-step-kind="user"]');
  await expect(assistant).toContainText("Tokenizers split text.");
  await expect(page.getByTestId("token-text")).toHaveCount(0);

  await openClientSettings(page);
  await toggleShowTokens(page);

  // The assistant's boundaries are the ones captured from the stream.
  await expect(assistant.getByTestId("token-text")).toHaveText("Token│izers│ split│ text│.");
  await expect(assistant.getByTestId("notice")).toContainText("stream boundaries");

  // The user's message was never streamed, so it is tokenized on demand against the conversation's model.
  await expect(user.getByTestId("token-text")).toHaveText("Show│ me│ tokens");
  await expect(user.getByTestId("notice")).toContainText("computed boundaries");
  expect(tokenizeRequests).toEqual([{ text: "Show me tokens", model: "qwen3:latest", provider: "ollama" }]);

  await toggleShowTokens(page);

  await expect(page.getByTestId("token-text")).toHaveCount(0);
  await expect(page.getByTestId("notice")).toHaveCount(0);
  await expect(assistant).toContainText("Tokenizers split text.");
  await expect(user).toContainText("Show me tokens");
});

test("keeps the token view and the stream boundaries across a reload", async ({ page }) => {
  await page.goto("/");
  await sendPrompt(page, "Persist these");
  await openClientSettings(page);
  await toggleShowTokens(page);
  await expect(page.locator('[data-step-kind="assistant"]').getByTestId("token-text")).toHaveText("Token│izers│ split│ text│.");

  await page.reload();

  // Stream boundaries cannot be recomputed after the fact; they must come back from storage.
  const assistant = page.locator('[data-step-kind="assistant"]');
  await expect(assistant.getByTestId("token-text")).toHaveText("Token│izers│ split│ text│.");
  await expect(assistant.getByTestId("notice")).toContainText("stream boundaries");
  await expect(page.locator('[data-step-kind="user"]').getByTestId("token-text")).toHaveText("Persist│ these");
});
