import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { resolveStaticFile } from "./static-files.js";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { ConnectionHandler } from "./ws-handler.js";
import { LlmRouter } from "./llm-router.js";
import { ToolDispatcher } from "./tool-executor.js";
import { WebSearchExecutor } from "./tools/web-search.js";
import { CurlExecutor } from "./tools/curl.js";
import { loadProviderConfigs } from "./provider-config.js";
import { AccessPolicy } from "./access-policy.js";
import { HttpInputError, isRecord, readJsonBody } from "./request-validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// Load .env / .envrc so the backend picks up the same env vars as Next.js.
for (const envFile of [".env", ".envrc"]) {
  try {
    const raw = readFileSync(resolve(PROJECT_ROOT, envFile), "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.replace(/^export\s+/, "").trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // File not found — skip
  }
}
const PORT = parseInt(process.env.PORT ?? process.env.WS_PORT ?? "3000", 10);
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? resolve(PROJECT_ROOT, "out"));
const MCP_CONFIG = process.env.MCP_CONFIG ?? resolve(__dirname, "mcp-config.json");
const accessPolicy = new AccessPolicy();

const providerConfigs = loadProviderConfigs();
const router = new LlmRouter(providerConfigs);

// Static tool registry — used by the /tools HTTP endpoint.
// MCP tools are per-connection and delivered via WebSocket tools.update instead.
const staticDispatcher = new ToolDispatcher();
staticDispatcher.register(new WebSearchExecutor());
staticDispatcher.register(new CurlExecutor());

console.log(
  `[server] Providers: ${providerConfigs.map((p) => p.name).join(", ")}`
);
console.log(
  `[server] Tools: ${staticDispatcher.getToolDefinitions().map((t) => t.name).join(", ") || "(none)"}`
);

// ── HTTP server with /models endpoint ────────────────────────────────

const httpServer = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const address = httpServer.address();
    const access = accessPolicy.check(req, typeof address === "object" && address ? address.port : PORT);
    if (access.status !== 200) {
      res.writeHead(access.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: access.status === 401 ? "Authentication required" : "Origin or host not allowed" }));
      return;
    }
    if (access.origin) res.setHeader("Access-Control-Allow-Origin", access.origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/models" && req.method === "GET") {
      try {
        const models = await router.listAllModels();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models }));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch models";
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (req.url === "/models/show" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        if (!isRecord(body) || typeof body.model !== "string" || !body.model.trim() ||
          (body.provider !== undefined && (typeof body.provider !== "string" || !body.provider.trim()))) {
          throw new HttpInputError(400, "Expected model and optional provider strings");
        }
        const meta = await router.showModelMeta(body.provider as string | undefined, body.model);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(meta));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch model metadata";
        res.writeHead(err instanceof HttpInputError ? err.status : 500, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (req.url === "/tools" && req.method === "GET") {
      const tools = staticDispatcher.getToolDefinitions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tools }));
      return;
    }

    // ── Static file serving (production) ──────────────────────────────
    if (existsSync(STATIC_DIR)) {
      const MIME: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".txt": "text/plain",
      };

      const filePath = resolveStaticFile(STATIC_DIR, req.url ?? "/");
      if (filePath) {
        const ext = extname(filePath);
        const contentType = MIME[ext] ?? "application/octet-stream";
        const body = readFileSync(filePath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(body);
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
);

// ── WebSocket server ─────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
httpServer.on("upgrade", (req, socket, head) => {
  const address = httpServer.address();
  const access = accessPolicy.check(req, typeof address === "object" && address ? address.port : PORT);
  if (access.status !== 200) {
    socket.end(`HTTP/1.1 ${access.status} ${access.status === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  console.log("[ws] client connected");
  const handler = new ConnectionHandler(ws, router);
  void handler.initMcp(MCP_CONFIG);

  ws.on("close", () => {
    console.log("[ws] client disconnected");
  });
});

httpServer.listen(PORT, accessPolicy.host, () => {
  const address = httpServer.address();
  console.log(`[server] Ollamable listening on http://localhost:${typeof address === "object" && address ? address.port : PORT}`);
});

function shutdown() {
  console.log("[server] shutting down...");
  wss.close();
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
