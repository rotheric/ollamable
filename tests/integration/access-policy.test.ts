import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { WebSocket } from "ws";
import { AccessPolicy } from "../../server/access-policy.js";

const children: ChildProcess[] = [];
async function startBackend(overrides: Record<string, string> = {}): Promise<number> {
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "server/index.ts"], {
    env: { ...process.env, PORT: "0", BACKEND_HOST: "127.0.0.1", BACKEND_AUTH_TOKEN: "", BACKEND_ALLOWED_ORIGINS: "", MCP_CONFIG: "/nonexistent/mcp-test.json", ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Backend did not start: ${output}`)), 10000);
    child.on("error", reject);
    child.on("exit", () => { clearTimeout(timer); reject(new Error(output)); });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
}
afterAll(async () => {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  }));
});

function http(port: number, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; origin?: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/tools", method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode!, origin: res.headers["access-control-allow-origin"] as string | undefined }));
    });
    req.on("error", reject);
    req.end();
  });
}
function websocket(port: number, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.once("unexpected-response", (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!); });
    ws.on("error", (error) => { if (ws.readyState !== WebSocket.CLOSED) reject(error); });
    ws.on("open", () => ws.send(JSON.stringify({ type: "ping" })));
    ws.on("message", (message) => {
      if (JSON.parse(message.toString()).type === "pong") { ws.close(); resolve(101); }
    });
  });
}

describe("real backend access policy", () => {
  let localPort: number;
  let remotePort: number;
  beforeAll(async () => {
    localPort = await startBackend({ BACKEND_ALLOWED_ORIGINS: "http://localhost:43210" });
    remotePort = await startBackend({ BACKEND_HOST: "0.0.0.0", BACKEND_AUTH_TOKEN: "test-secret", BACKEND_ALLOWED_ORIGINS: "https://chat.example" });
  });

  it("defaults to loopback and refuses remote startup without explicit credentials/origins", async () => {
    expect(new AccessPolicy({}).host).toBe("127.0.0.1");
    await expect(startBackend({ BACKEND_HOST: "0.0.0.0" })).rejects.toThrow("Remote binding requires");
    expect(() => new AccessPolicy({ BACKEND_HOST: "::", BACKEND_AUTH_TOKEN: "token" })).toThrow("Remote binding requires");
  });

  it.each(["https://untrusted.example", "null", "http://localhost:43211"])("rejects HTTP and WebSocket origin %s", async (origin) => {
    expect(await http(localPort, { origin })).toEqual({ status: 403, origin: undefined });
    expect(await websocket(localPort, { origin })).toBe(403);
  });

  it("allows same-origin and explicitly configured development origins", async () => {
    for (const origin of [`http://127.0.0.1:${localPort}`, "http://localhost:43210"]) {
      expect(await http(localPort, { origin })).toEqual({ status: 200, origin });
      expect(await websocket(localPort, { origin })).toBe(101);
    }
    expect((await http(localPort)).status).toBe(200);
    expect(await websocket(localPort)).toBe(101);
  });

  it("rejects DNS-rebinding hosts even without an Origin header", async () => {
    expect((await http(localPort, { host: "untrusted.example" })).status).toBe(403);
    expect(await websocket(localPort, { host: "untrusted.example" })).toBe(403);
  });

  it.each([undefined, "Bearer wrong"])("requires a valid token for HTTP and WebSocket remote access (%s)", async (authorization) => {
    const headers = { origin: "https://chat.example", ...(authorization ? { authorization } : {}) };
    expect((await http(remotePort, headers)).status).toBe(401);
    expect(await websocket(remotePort, headers)).toBe(401);
  });

  it("accepts authenticated configured origins but rejects hostile origins even with credentials", async () => {
    const headers = { authorization: "Bearer test-secret", origin: "https://chat.example" };
    expect(await http(remotePort, headers)).toEqual({ status: 200, origin: headers.origin });
    expect(await websocket(remotePort, headers)).toBe(101);
    expect(await websocket(remotePort, { ...headers, origin: "https://untrusted.example" })).toBe(403);
    expect((await http(remotePort, { origin: headers.origin }, "OPTIONS")).status).toBe(204);
  });
});
