import { randomUUID } from "node:crypto";
import type { ToolExecutor } from "../tool-executor.js";
import type { MetaEvent, ToolDefinition } from "../types.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const HARD_MAX_BYTES = 2 * 1024 * 1024;

export class CurlExecutor implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        id: "curl",
        name: "curl",
        description:
          "Fetches arbitrary content from a URL over HTTP(S). Returns status, response headers, and body (truncated to max_bytes). Supports GET/POST/PUT/DELETE with custom headers and body.",
        inputSchema: JSON.stringify({
          type: "object",
          properties: {
            url: { type: "string", description: "The absolute http:// or https:// URL to fetch." },
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
              description: "HTTP method (default GET).",
            },
            headers: {
              type: "object",
              description: "Optional request headers as a flat string→string map.",
              additionalProperties: { type: "string" },
            },
            body: {
              type: "string",
              description: "Optional request body. For JSON, supply a stringified payload and set Content-Type in headers.",
            },
            max_bytes: {
              type: "number",
              description: `Maximum response body bytes to return (default ${DEFAULT_MAX_BYTES}, hard cap ${HARD_MAX_BYTES}). Larger responses are truncated.`,
            },
          },
          required: ["url"],
        }),
      },
    ];
  }

  canHandle(name: string): boolean {
    return name === "curl";
  }

  async execute(
    _name: string,
    args: Record<string, unknown>,
    emit: (event: MetaEvent) => void,
    signal?: AbortSignal
  ): Promise<string> {
    signal?.throwIfAborted();
    const url = String(args.url ?? "");
    const method = String(args.method ?? "GET").toUpperCase();
    const headers = (args.headers && typeof args.headers === "object"
      ? (args.headers as Record<string, string>)
      : {});
    const body = typeof args.body === "string" ? args.body : undefined;
    const maxBytes = Math.min(
      Math.max(1, Number(args.max_bytes) || DEFAULT_MAX_BYTES),
      HARD_MAX_BYTES
    );
    const startTime = Date.now();

    emit({
      id: randomUUID(),
      kind: "fetch_start",
      title: "Curl",
      detail: `${method} ${url}`,
      data: { url, method },
      timestamp: new Date().toISOString(),
    });

    const fail = (message: string): string => {
      const durationMs = Date.now() - startTime;
      emit({
        id: randomUUID(),
        kind: "fetch_result",
        title: "Curl Failed",
        detail: message,
        data: { error: message, url, method },
        timestamp: new Date().toISOString(),
        durationMs,
      });
      return JSON.stringify({ url, method, error: message });
    };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail(`Invalid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fail(`Only http(s) URLs are supported (got ${parsed.protocol}).`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        redirect: "follow",
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const buffer = await response.arrayBuffer();
      const totalBytes = buffer.byteLength;
      const truncated = totalBytes > maxBytes;
      const bodyBytes = truncated ? buffer.slice(0, maxBytes) : buffer;

      const contentType = responseHeaders["content-type"] ?? "";
      const isBinary =
        !contentType.startsWith("text/") &&
        !/application\/(json|xml|javascript|x-www-form-urlencoded|ld\+json)/.test(contentType) &&
        !/\+json|\+xml/.test(contentType);

      const decodedBody = isBinary
        ? `<binary content: ${totalBytes} bytes, content-type=${contentType || "unknown"}>`
        : new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes);

      const durationMs = Date.now() - startTime;

      emit({
        id: randomUUID(),
        kind: "fetch_result",
        title: `Curl ${response.status}`,
        detail: `${method} ${url} → ${response.status} ${response.statusText} (${totalBytes} bytes${truncated ? ", truncated" : ""}) in ${durationMs}ms`,
        data: {
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          bytes: totalBytes,
          truncated,
          durationMs,
        },
        timestamp: new Date().toISOString(),
        durationMs,
      });

      return JSON.stringify({
        url,
        method,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: decodedBody,
        bytes: totalBytes,
        truncated,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (controller.signal.aborted) {
        return fail(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
      }
      const message =
        error instanceof Error ? error.message : "Unknown fetch error";
      return fail(message);
    } finally {
      clearTimeout(timer);
    }
  }
}
