import { expect, test, type Page } from "@playwright/test";

const sidebar = { sidebarOpen: false, rightSidebarOpen: true, tempSectionOpen: true, renderMarkdown: true };

test.beforeEach(async ({ page }) => {
  await page.addInitScript((initialSidebar) => {
    if (sessionStorage.getItem("tour-test-initialized")) return;
    sessionStorage.setItem("tour-test-initialized", "true");
    localStorage.clear();
    localStorage.setItem("ollamable.sidebarState", JSON.stringify(initialSidebar));
  }, sidebar);
  await page.route("**/models", (route) => route.fulfill({ json: { models: [{ name: "qwen3:latest", provider: "ollama", family: "qwen" }] } }));
  await page.route("**/tools", (route) => route.fulfill({ json: { tools: [{ id: "web-search", name: "web_search", description: "Search", inputSchema: '{"type":"object"}' }] } }));
  await page.routeWebSocket(/ws/, (ws) => ws.onMessage((raw) => {
    const data = JSON.parse(raw.toString());
    if (data.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    if (data.type === "chat.send") ws.send(JSON.stringify({ type: "chat.done", conversationId: data.conversationId, requestId: data.requestId,
      steps: [{ id: "tour-edited-answer", kind: "assistant", title: "Assistant", content: "Answer to the edited example", createdAt: new Date().toISOString(), expanded: true }] }));
  }));
});

async function expectRestoredSidebar(page: Page) {
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("ollamable.sidebarState")!)))
    .toMatchObject(sidebar);
}
async function readConversations(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("ollamable.conversations")!));
}

test("automatically starts, skips untouched examples, restores sidebars and persists completion", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("alertdialog")).toContainText("Active Tools");
  await expect.poll(async () => (await readConversations(page)).filter((c: { _tourExample?: boolean }) => c._tourExample).length).toBe(1);
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expectRestoredSidebar(page);
  await expect.poll(async () => (await readConversations(page)).some((c: { _tourExample?: boolean }) => c._tourExample)).toBe(false);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "User Prompt" })).toBeVisible();
  await page.waitForTimeout(700); // pass the documented 500ms automatic-start window
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("replays the real tour through Finish and cancels delayed work", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Skip tour" }).click();
  await page.getByRole("button", { name: "Take tour", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Active Tools");
  for (let step = 0; step < 10; step++) {
    await page.getByRole("alertdialog").getByRole("button", { name: `Next (${step + 1} of 11)`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("ollamable.tourStep"))).toBe(String(step + 1));
  }
  await page.getByRole("alertdialog").getByRole("button", { name: /^Finish/ }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.waitForTimeout(900); // cover the delayed tool toggle after completion
  await expectRestoredSidebar(page);
  expect(await page.evaluate(() => localStorage.getItem("ollamable.tourStep"))).toBeNull();
  expect((await readConversations(page)).some((c: { _tourExample?: boolean }) => c._tourExample)).toBe(false);
});

test("resumes after refresh and preserves an edited example when skipped", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("alertdialog").getByRole("button", { name: /^Next/ }).click();
  await expect(page.getByRole("alertdialog")).toContainText("System Prompt");
  await page.getByRole("alertdialog").getByRole("button", { name: /^Next/ }).click();
  await expect(page.getByRole("alertdialog")).toContainText("User Message");
  await page.reload();
  await expect(page.getByRole("alertdialog")).toContainText("User Message");
  await page.locator('[data-tour="step-user"]').getByRole("button", { name: "Edit message" }).click();
  const editor = page.getByRole("textbox", { name: "Edit message" });
  await editor.fill("Keep this edited example");
  await editor.press("Enter");
  await expect(page.getByText("Answer to the edited example", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expectRestoredSidebar(page);
  await expect.poll(async () => (await readConversations(page)).some((c: { _tourExample?: boolean; steps: Array<{ content: string }> }) =>
    !c._tourExample && c.steps.some((s) => s.content === "Keep this edited example"))).toBe(true);
  await page.reload();
  await expect(page.getByText("Answer to the edited example", { exact: true })).toBeVisible();
});
