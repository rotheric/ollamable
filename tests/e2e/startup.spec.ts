import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import manifest from "../../package.json";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

// No page.route or routeWebSocket: browser -> real backend -> local deterministic provider.
for (const mode of ["production", "development"] as const) {
  test(`${mode} entrypoint serves a real browser/backend/provider${mode === "production" ? "/tool" : ""} round trip`, async ({ page }) => {
    test.setTimeout(90_000);
    const frontendPort = await freePort();
    const backendPort = mode === "production" ? frontendPort : await freePort();
    const requests: Array<{ model?: string; tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_name?: string }> }> = [];
    let toolRequests = 0;
    const provider = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/tags") res.end(JSON.stringify({ models: [{ name: "qwen3:latest", details: { family: "qwen" } }] }));
      else if (req.url === "/api/show") res.end(JSON.stringify({ capabilities: ["completion"], details: { family: "qwen" } }));
      else if (req.url === "/api/chat") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        requests.push(JSON.parse(raw));
        res.setHeader("Content-Type", "application/x-ndjson");
        const message = mode === "production" && requests.length === 1
          ? { role: "assistant", content: "", tool_calls: [{ function: { name: "curl", arguments: { url: `http://127.0.0.1:${providerPort}/tool-target` } } }] }
          : { role: "assistant", content: "Real provider response" };
        res.end(JSON.stringify({ message, done: true, prompt_eval_count: 5, eval_count: 3 }) + "\n");
      } else if (req.url === "/tool-target") {
        toolRequests++;
        res.end(JSON.stringify({ evidence: "real local tool result" }));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerPort = (provider.address() as { port: number }).port;
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(backendPort), FRONTEND_PORT: String(frontendPort), BACKEND_PORT: String(backendPort),
      OPEN_BROWSER: "0", BACKEND_HOST: "127.0.0.1", FRONTEND_HOST: "127.0.0.1", BACKEND_AUTH_TOKEN: "", MINIMAX_API_KEY: "",
      OLLAMA_URL: `http://127.0.0.1:${providerPort}/api`, MCP_CONFIG: "/nonexistent/startup-test-mcp.json" };
    delete env.NEXT_PUBLIC_WS_URL;
    delete env.BACKEND_ALLOWED_ORIGINS;
    const [command, ...args] = (mode === "production" ? manifest.scripts.start : manifest.scripts["dev:full"]).split(" ");
    const child = spawn(command === "node" ? process.execPath : command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    try {
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(`Startup exited: ${output}`);
        try { const response = await fetch(`http://127.0.0.1:${frontendPort}`, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); return response.status; }
        catch { return 0; }
      }, { timeout: 60_000 }).toBe(200);
      await page.addInitScript(() => { localStorage.setItem("ollamable.tourCompleted", "true"); });
      await page.goto(`http://127.0.0.1:${frontendPort}`);
      await expect.poll(() => output.includes("[ws] client connected")).toBe(true);
      if (mode === "production") {
        await page.getByRole("button", { name: "Expand tools sidebar" }).click();
        await page.getByRole("button", { name: "Tools", exact: true }).click();
        await page.getByText("built-in").click();
        await page.getByRole("checkbox", { name: /^curl/ }).check();
      }
      await page.getByRole("textbox", { name: "User Prompt" }).fill("Real startup request");
      await page.getByRole("textbox", { name: "User Prompt" }).press("Enter");
      await expect(page.getByText("Real provider response", { exact: true })).toBeVisible();
      expect(requests).toHaveLength(mode === "production" ? 2 : 1);
      expect(requests[0]).toMatchObject({ model: "qwen3:latest", messages: expect.arrayContaining([{ role: "user", content: "Real startup request" }]) });
      if (mode === "production") {
        expect(toolRequests).toBe(1);
        expect(requests[0].tools?.map((tool) => tool.function.name)).toContain("curl");
        expect(requests[1].messages).toEqual(expect.arrayContaining([
          { role: "assistant", content: "", tool_calls: [{ function: { name: "curl", arguments: { url: `http://127.0.0.1:${providerPort}/tool-target` } } }] },
          expect.objectContaining({ role: "tool", tool_name: "curl", content: expect.stringContaining("real local tool result") }),
        ]));
        await expect(page.locator('[data-step-kind="tool_result"]')).toContainText("real local tool result");
        await expect(page.locator('[data-step-kind="assistant"]')).toHaveCount(1);
      }
    } catch (error) {
      throw new Error(`${String(error)}\nStartup logs:\n${output}`);
    } finally {
      await page.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await exited;
      }
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
    await expect.poll(() => isListening(frontendPort)).toBe(false);
    await expect.poll(() => isListening(backendPort)).toBe(false);
  });
}
