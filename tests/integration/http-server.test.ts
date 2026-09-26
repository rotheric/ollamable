import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { WebSocket } from "ws";

describe("production HTTP static boundary", () => {
  let child: ChildProcess;
  let directory: string;
  let port: number;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "llm-browser-http-"));
    const root = join(directory, "out");
    mkdirSync(join(root, "nested"), { recursive: true });
    mkdirSync(join(directory, "out-sibling"));
    writeFileSync(join(directory, "private.txt"), "private");
    writeFileSync(join(directory, "out-sibling", "private.txt"), "private sibling");
    writeFileSync(join(root, "index.html"), "home");
    writeFileSync(join(root, "page.html"), "page");
    writeFileSync(join(root, "nested", "index.html"), "nested");
    writeFileSync(join(root, "asset.js"), "asset");
    writeFileSync(join(root, "space name.txt"), "space");
    symlinkSync(join(directory, "private.txt"), join(root, "escape.txt"));
    symlinkSync(join(directory, "out-sibling"), join(root, "escape-dir"));
    child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "server/index.ts"], {
      env: { ...process.env, PORT: "0", STATIC_DIR: root, MCP_CONFIG: join(directory, "missing.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 10000);
      child.once("error", reject);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
      child.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        const match = output.match(/listening on http:\/\/localhost:(\d+)/);
        if (match) { port = Number(match[1]); clearTimeout(timer); resolve(); }
      });
    });
  });

  afterAll(async () => {
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function get(path: string, bodyToSend?: string, chunked = false): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      // Raw request paths preserve dot segments that fetch/URL would normalize away.
      const headers = bodyToSend === undefined ? {} : chunked
        ? { "Transfer-Encoding": "chunked" } : { "Content-Length": Buffer.byteLength(bodyToSend) };
      const req = request({ hostname: "127.0.0.1", port, path, headers, method: bodyToSend === undefined ? "GET" : "POST" }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject);
      if (bodyToSend !== undefined) req.write(bodyToSend);
      req.end();
    });
  }

  it.each([
    "/../private.txt", "/%2e%2e/private.txt", "/..%2fprivate.txt",
    "/%2e%2e%2fout-sibling/private.txt", "/nested/../../private.txt",
    "/escape.txt", "/escape-dir/private.txt", "/%00", "/%ZZ", "/..%5cprivate.txt",
  ])("rejects traversal or invalid path %s", async (path) => {
    expect((await get(path)).status).toBe(404);
  });

  it.each([
    ["/", "home"], ["/page", "page"], ["/nested/", "nested"],
    ["/asset.js?version=1", "asset"], ["/space%20name.txt", "space"],
  ])("serves exported content at %s", async (path, body) => {
    expect(await get(path)).toEqual({ status: 200, body });
  });
  it.each(["{broken", "null", '{"model":1}', '{"model":"m","provider":false}'])("validates metadata JSON input %s", async (body) => {
    expect((await get("/models/show", body)).status).toBe(400);
  });

  it.each([false, true])("rejects oversized metadata uploads with chunked=%s", async (chunked) => {
    expect((await get("/models/show", JSON.stringify({ model: "x".repeat(70 * 1024) }), chunked)).status).toBe(413);
    expect((await get("/tools")).status).toBe(200);
  });

  it("closes oversized WebSocket messages without crashing the backend", async () => {
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("error", reject);
      ws.on("open", () => ws.send("x".repeat(1024 * 1024 + 1)));
      ws.on("close", resolve);
    });
    expect(code).toBe(1009);
    expect((await get("/tools")).status).toBe(200);
  });

});
