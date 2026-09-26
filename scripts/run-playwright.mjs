import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const children = new Set();
function launch(args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  children.add(child);
  child.completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { children.delete(child); resolve(code ?? 1); });
  });
  // Server startup errors can precede the await in cleanup.
  child.completion.catch(() => {});
  return child;
}
async function stopChildren() {
  const pending = [...children];
  for (const child of pending) child.kill("SIGTERM");
  const timeout = setTimeout(() => { for (const child of pending) child.kill("SIGKILL"); }, 5000);
  await Promise.allSettled(pending.map((child) => child.completion));
  clearTimeout(timeout);
}
let stopping = false;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.once(signal, () => {
  stopping = true;
  void stopChildren().then(() => process.exit(code));
});
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return String(port);
}
try {
  const args = process.argv.slice(2);
  const skipBuild = args.includes("--skip-build");
  if (!skipBuild) {
    const code = await launch(["node_modules/next/dist/bin/next", "build"]).completion;
    if (code) throw new Error(`Static build failed (${code}).`);
  }
  if (stopping) process.exit(1);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = launch(["scripts/start.mjs"], {
    PORT: port, BACKEND_HOST: "127.0.0.1", BACKEND_AUTH_TOKEN: "", BACKEND_ALLOWED_ORIGINS: "",
    MCP_CONFIG: resolve(root, "test-results/no-mcp-config.json"), MINIMAX_API_KEY: "",
    OLLAMA_URL: "http://127.0.0.1:1/api", STATIC_DIR: resolve(root, "out"),
  });
  let ready = false;
  for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
    if (server.exitCode !== null) throw new Error(`Test server exited (${server.exitCode}).`);
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) { ready = true; break; }
    } catch { /* awaiting startup */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Test server did not become ready at ${baseUrl}.`);
  const runner = launch(["node_modules/@playwright/test/cli.js", "test", ...args.filter((arg) => arg !== "--skip-build")], { PLAYWRIGHT_BASE_URL: baseUrl });
  process.exitCode = await runner.completion;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await stopChildren();
}
