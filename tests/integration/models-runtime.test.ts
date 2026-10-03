import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import manifest from "../../package.json";
import { fetchOllamaRuntime } from "../../server/ollama-client.js";
import { LlmRouter } from "../../server/llm-router.js";

/** A stubbed Ollama: serves GET /api/ps and records every path it is asked for. */
function startFakeOllama(psBody: unknown): Promise<{ server: Server; port: number; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/api/ps") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(psBody));
      return;
    }
    res.writeHead(500);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, paths })));
}

describe("POST /models/runtime (AC-CTX-5)", () => {
  let child: ChildProcess;
  let directory: string;
  let port: number;
  let fake: Awaited<ReturnType<typeof startFakeOllama>>;

  beforeAll(async () => {
    fake = await startFakeOllama({
      models: [
        { name: "qwen3:1.7b", model: "qwen3:1.7b", context_length: 4096 },
        { name: "llama3:latest", model: "llama3:latest", context_length: 8192 },
      ],
    });
    directory = mkdtempSync(join(tmpdir(), "llm-browser-runtime-"));
    mkdirSync(join(directory, "out"));
    writeFileSync(join(directory, "out", "index.html"), "home");
    const [command, ...args] = manifest.scripts.start.split(" ");
    child = spawn(command === "node" ? process.execPath : command, args, {
      env: {
        ...process.env,
        PORT: "0",
        STATIC_DIR: join(directory, "out"),
        MCP_CONFIG: join(directory, "missing.json"),
        OLLAMA_URL: `http://127.0.0.1:${fake.port}/api`,
        MINIMAX_API_KEY: "test-key",
        MINIMAX_BASE_URL: "http://127.0.0.1:9/v1",
      },
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
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function post(body: string): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path: "/models/runtime", method: "POST", headers: { "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          let text = "";
          res.on("data", (chunk) => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(text) }));
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("returns the loaded window of a model listed by /api/ps", async () => {
    expect(await post(JSON.stringify({ model: "qwen3:1.7b", provider: "ollama" }))).toEqual({
      status: 200,
      json: { loaded: true, metadata: true, contextLength: 4096 },
    });
  });

  it("returns { loaded: false } for an unlisted model", async () => {
    expect(await post(JSON.stringify({ model: "gemma3:1b", provider: "ollama" }))).toEqual({ status: 200, json: { loaded: false, metadata: true } });
  });

  it("returns { loaded: false } for an OpenAI-compatible provider without contacting it", async () => {
    expect(await post(JSON.stringify({ model: "MiniMax-M2.7", provider: "minimax" }))).toEqual({ status: 200, json: { loaded: false, metadata: false } });
  });

  it("only ever reads /api/ps: never /api/generate, /api/chat, /api/embed or any POST", async () => {
    await post(JSON.stringify({ model: "qwen3:1.7b" }));
    expect(fake.paths.length).toBeGreaterThan(0);
    expect(new Set(fake.paths)).toEqual(new Set(["GET /api/ps"]));
  });

  it.each(["{broken", "null", "[]", '{"model":1}', '{"model":""}', '{"model":"m","provider":false}', '{"model":"m","provider":""}'])(
    "rejects malformed input %s with 400 before reaching /api/ps",
    async (body) => {
      const before = fake.paths.length;
      expect((await post(body)).status).toBe(400);
      expect(fake.paths.length).toBe(before);
    }
  );

  it("reports an unknown explicit provider as an error, not a crash", async () => {
    const result = await post(JSON.stringify({ model: "m", provider: "nope" }));
    expect(result.status).toBe(500);
    expect(result.json.error).toContain("Unknown provider");
  });
});

describe("fetchOllamaRuntime parsing", () => {
  afterEach(() => vi.restoreAllMocks());

  function stubPs(body: unknown, status = 200) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));
  }

  it("matches an untagged request to the :latest entry Ollama lists", async () => {
    stubPs({ models: [{ name: "llama3:latest", model: "llama3:latest", context_length: 8192 }] });
    expect(await fetchOllamaRuntime("http://x/api", "llama3")).toEqual({ loaded: true, contextLength: 8192 });
  });

  it("does not mistake a registry port for a tag", async () => {
    const listed = "localhost:5000/team/model:latest";
    stubPs({ models: [{ name: listed, model: listed, context_length: 4096 }] });
    expect(await fetchOllamaRuntime("http://x/api", "localhost:5000/team/model")).toEqual({ loaded: true, contextLength: 4096 });
  });

  it.each([
    [null],
    [{}],
    [{ models: null }],
    [{ models: "none" }],
    [{ models: [null, 3, "x"] }],
    [{ models: [{ name: "m" }] }],
    [{ models: [{ name: "m", context_length: 0 }] }],
    [{ models: [{ name: "m", context_length: "4096" }] }],
    [{ models: [{ name: "m", context_length: 1.5 }] }],
    [{ models: [{ name: "other", context_length: 4096 }] }],
  ])("is { loaded: false } for the malformed or non-matching response %j", async (body) => {
    stubPs(body);
    expect(await fetchOllamaRuntime("http://x/api", "m")).toEqual({ loaded: false });
  });

  it("uses a later matching entry when an earlier match lacks a window", async () => {
    stubPs({ models: [{ name: "m" }, { name: "m", context_length: 2048 }] });
    expect(await fetchOllamaRuntime("http://x/api", "m")).toEqual({ loaded: true, contextLength: 2048 });
  });

  it("only issues GET /ps", async () => {
    stubPs({ models: [] });
    await fetchOllamaRuntime("http://x/api", "m");
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("http://x/api/ps");
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("aborts the /ps read when the caller aborts, so a hung Ollama cannot stall the request", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      }));
    const caller = new AbortController();
    const pending = fetchOllamaRuntime("http://x/api", "m", caller.signal);
    caller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
  });

  it("surfaces an upstream failure", async () => {
    stubPs({}, 503);
    await expect(fetchOllamaRuntime("http://x/api", "m")).rejects.toThrow("503");
  });
});

describe("LlmRouter.runtimeInfo provider gate", () => {
  it("answers { loaded: false } for openai-compat providers by type, whatever the provider id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const router = new LlmRouter([
      { id: "ollama", type: "openai-compat", name: "Looks like Ollama", baseUrl: "http://x/v1" },
    ]);
    expect(await router.runtimeInfo("ollama", "m")).toEqual({ loaded: false, metadata: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("answers an Ollama provider from /api/ps and marks metadata as available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "m:latest", context_length: 4096 }] }), { status: 200 })
    );
    const router = new LlmRouter([{ id: "local", type: "ollama", name: "Local", baseUrl: "http://x/api" }]);
    expect(await router.runtimeInfo("local", "m")).toEqual({ loaded: true, contextLength: 4096, metadata: true });
    vi.restoreAllMocks();
  });
});
