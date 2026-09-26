import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function port(value, label) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid ${label}: ${value}`);
  return String(Number(value));
}
const frontendPort = port(process.env.FRONTEND_PORT ?? process.env.PORT ?? "3000", "frontend port");
const backendPort = port(process.env.BACKEND_PORT ?? process.env.WS_PORT ?? String(Number(frontendPort) + 1), "backend port");
if (frontendPort === backendPort) throw new Error("Frontend and backend ports must differ.");
const frontendHost = process.env.FRONTEND_HOST ?? "127.0.0.1";
const backendHost = process.env.BACKEND_HOST ?? "127.0.0.1";
const backendAuthority = backendHost.includes(":") ? `[${backendHost}]` : backendHost;
const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? `ws://${backendAuthority}:${backendPort}`;
const url = `http://127.0.0.1:${frontendPort}`;

console.log(`[dev] Frontend: ${url}; backend: ${wsUrl}`);
const children = [];
let stopping = false;
function launch(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env });
  children.push(child);
  child.on("error", (error) => { console.error(error.message); shutdown(1); });
  child.on("exit", (code) => { if (!stopping) shutdown(code ?? 1); });
  return child;
}
launch(["node_modules/tsx/dist/cli.mjs", "watch", "server/index.ts"], {
  ...process.env, PORT: backendPort, BACKEND_HOST: backendHost,
  BACKEND_ALLOWED_ORIGINS: process.env.BACKEND_ALLOWED_ORIGINS ?? `http://127.0.0.1:${frontendPort},http://localhost:${frontendPort}`,
});
launch(["node_modules/next/dist/bin/next", "dev", "--hostname", frontendHost, "--port", frontendPort], {
  ...process.env, NEXT_PUBLIC_WS_URL: wsUrl,
});

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const pending = children.filter((child) => child.exitCode === null && child.signalCode === null);
  const exited = Promise.all(pending.map((child) => new Promise((done) => child.once("exit", done))));
  for (const child of pending) child.kill("SIGTERM");
  const force = setTimeout(() => {
    for (const child of pending) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5000);
  force.unref();
  void exited.then(() => { clearTimeout(force); process.exit(code); });
}
process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));

async function openWhenReady() {
  if (process.env.OPEN_BROWSER === "0") return;
  for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) {
        const [command, args] = process.platform === "darwin" ? ["open", [url]]
          : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
        const browser = spawn(command, args, { stdio: "ignore", detached: true });
        browser.on("error", () => {});
        browser.unref();
        return;
      }
    } catch { /* still starting */ }
    await new Promise((done) => setTimeout(done, 500));
  }
}
void openWhenReady();
