/**
 * Behavioural tests for three features of server/ollama-client.ts that a
 * mutation audit found had no test at all (every mutant in them reported
 * NoCoverage): the model-metadata fetch, the tool declarations attached
 * to an outgoing chat request, and the tool calls a model makes mid-
 * stream.
 *
 * Companion to tests/integration/ollama-client-stream-boundaries.test.ts,
 * which owns contentTokens retention and the delta-accumulation join
 * invariant (AC-STRUCT-2, AC-TOK-4). This file owns the surfaces that
 * suite never reaches.
 *
 * AC linkage (plugins/base/skills/property-based-testing/
 * acceptance-criteria-linkage.md):
 *  - The `/api/show` success path is the transport epic-token-view:AC-UX-5
 *    depends on ("the model's chat template string verbatim as returned in
 *    the `template` field of `POST /api/show`") and AC-PERF-1 counts calls
 *    against; it is cited below.
 *  - Its failure path, the tool-declaration translation, and mid-stream
 *    tool-call collection have NO acceptance criterion in any epic —
 *    epic-token-view does not scope them and no other epic owns
 *    server/ollama-client.ts. They are genuine spec gaps; the properties
 *    are still worth writing because the behaviour is observable and a
 *    model that receives a malformed tool declaration silently stops
 *    calling the tool. The paired spec-gap findings are surfaced by the
 *    audit that produced this file (this project still carries the legacy
 *    v2 BACKLOG.md, so there is no BACKLOG.json to file them into).
 *
 * Determinism: fast-check runs are seeded so the test *names* stay
 * stable — Stryker filters the suite by test name.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fc from "fast-check";
import {
  buildOllamaChatBody,
  fetchOllamaModelMeta,
  streamOllamaResponse,
} from "../../server/ollama-client.js";
import type { ConversationStep, ToolDefinition } from "../../server/types.js";

const SEED = 1337;
const RUNS = 200;

const userStep: ConversationStep = {
  id: "u1",
  kind: "user",
  title: "User",
  content: "Hello",
  createdAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Asking Ollama about a model ──────────────────────────────────────

describe("asking Ollama what a model looks like", () => {
  it("returns what the model reports about itself, including the chat template the request preview shows verbatim (epic-token-view:AC-UX-5)", async () => {
    const body = {
      template: "{{- range .Messages }}<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{- end }}",
      details: { parameter_size: "1.7B" },
      capabilities: ["completion", "tools"],
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

    const meta = await fetchOllamaModelMeta("http://ollama.test/api", "qwen3:1.7b");

    expect(meta).toEqual(body);
    // The model is named in the request, not in the URL — a /show call
    // that forgot to say which model would describe the wrong one.
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ollama.test/api/show");
    expect(JSON.parse(init.body as string)).toEqual({ model: "qwen3:1.7b" });
  });

  it("fails loudly, naming the status, when the model cannot be described — so the panel reports a problem instead of rendering an empty template", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));

    await expect(fetchOllamaModelMeta("http://ollama.test/api", "ghost:latest")).rejects.toThrow(
      /404/,
    );
  });
});

// ── Declaring tools to the model ─────────────────────────────────────
//
// A tool reaches the app as a free-form `inputSchema` string: MCP servers
// send real JSON Schema, the built-in tools use a terse
// `{"query": "string", "limit": "number?"}` shorthand, and a broken
// server can send anything at all. Whatever arrives, the model has to be
// handed a parameter object it can actually fill in.

function parametersFor(inputSchema: string): Record<string, unknown> {
  const tool: ToolDefinition = { id: "t1", name: "probe", description: "d", inputSchema };
  const body = buildOllamaChatBody({
    model: "qwen3:latest",
    steps: [userStep],
    tools: [tool],
    stream: false,
  }) as { tools: Array<{ type: string; function: { name: string; parameters: Record<string, unknown> } }> };
  return body.tools[0].function.parameters;
}

describe("declaring a tool to the model", () => {
  it("passes a tool's own JSON Schema through untouched, so an MCP server's contract reaches the model as written", () => {
    const schema = {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
      additionalProperties: false,
    };

    expect(parametersFor(JSON.stringify(schema))).toEqual(schema);
  });

  it("turns the terse shorthand declaration into a schema the model can fill in, with the optional arguments left optional", () => {
    const parameters = parametersFor(
      JSON.stringify({ query: "string", limit: "number?", exact: "Boolean", count: "INTEGER" }),
    );

    expect(parameters).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        exact: { type: "boolean" },
        count: { type: "number" },
      },
      // Only the arguments the tool actually needs — a trailing "?" marks
      // one the caller may leave out.
      required: ["query", "exact", "count"],
    });
  });

  it("asks for nothing when every shorthand argument is optional, rather than demanding an empty list", () => {
    const parameters = parametersFor(JSON.stringify({ q: "string?", n: "number?" }));

    expect(parameters).not.toHaveProperty("required");
  });

  it("keeps a tool usable when its declaration cannot be read at all, handing the model a single free-text argument that quotes the original declaration", () => {
    const parameters = parametersFor("this is not JSON");

    expect(parameters).toEqual({
      type: "object",
      properties: { raw_input: { type: "string", description: "this is not JSON" } },
    });
  });

  it("always hands the model a fillable parameter object, whatever a tool server declared", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (declaration) => {
        const parameters = parametersFor(declaration);

        // Never null, never a bare scalar, and always carrying enough
        // structure for the model to know what to send: a tool whose
        // parameters are unusable is a tool the model silently stops
        // calling.
        expect(parameters).toBeTypeOf("object");
        expect(parameters).not.toBeNull();
        expect("type" in parameters || "properties" in parameters).toBe(true);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

// ── Tool calls the model makes mid-stream ────────────────────────────

function streamOf(chunks: Array<Record<string, unknown>>, options: { trailingNewline?: boolean } = {}) {
  const text = chunks.map((c) => JSON.stringify(c)).join("\n") + (options.trailingNewline === false ? "" : "\n");
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

  return streamOllamaResponse({
    model: "qwen3:latest",
    steps: [userStep],
    tools: [],
    onDelta: () => {},
  });
}

describe("a model that calls tools while it answers", () => {
  it("records each tool the model asked for, with the arguments it asked for", async () => {
    const steps = await streamOf([
      {
        message: {
          content: "",
          tool_calls: [
            { function: { name: "get_weather", arguments: { city: "Berlin" } } },
            { function: { name: "web_search", arguments: { q: "rain" } } },
          ],
        },
        done: false,
      },
      { done: true, done_reason: "stop" },
    ]);

    const calls = steps.filter((s) => s.kind === "tool_call");
    expect(calls.map((s) => s.toolCall)).toEqual([
      { name: "get_weather", arguments: { city: "Berlin" } },
      { name: "web_search", arguments: { q: "rain" } },
    ]);
  });

  it("asks for a tool only once when the model repeats the identical request across chunks, so it is not run twice", async () => {
    const call = { function: { name: "get_weather", arguments: { city: "Berlin" } } };
    const steps = await streamOf([
      { message: { content: "", tool_calls: [call] }, done: false },
      { message: { content: "", tool_calls: [call] }, done: false },
      { done: true, done_reason: "stop" },
    ]);

    expect(steps.filter((s) => s.kind === "tool_call")).toHaveLength(1);
  });

  it("treats the same tool asked with different arguments as a second, separate request", async () => {
    const steps = await streamOf([
      {
        message: {
          content: "",
          tool_calls: [{ function: { name: "get_weather", arguments: { city: "Berlin" } } }],
        },
        done: false,
      },
      {
        message: {
          content: "",
          tool_calls: [{ function: { name: "get_weather", arguments: { city: "Hamburg" } } }],
        },
        done: false,
      },
      { done: true, done_reason: "stop" },
    ]);

    expect(steps.filter((s) => s.kind === "tool_call")).toHaveLength(2);
  });

  it("still records a request whose name or arguments the model left out, rather than dropping it silently", async () => {
    const steps = await streamOf([
      { message: { content: "", tool_calls: [{ function: {} }] }, done: false },
      { done: true, done_reason: "stop" },
    ]);

    const call = steps.find((s) => s.kind === "tool_call");
    expect(call?.toolCall).toEqual({ name: "tool_call", arguments: {} });
  });

  it("treats two different tools asked with identical arguments as two separate requests", async () => {
    const steps = await streamOf([
      {
        message: {
          content: "",
          tool_calls: [
            { function: { name: "web_search", arguments: { q: "berlin" } } },
            { function: { name: "read_file", arguments: { q: "berlin" } } },
          ],
        },
        done: false,
      },
      { done: true, done_reason: "stop" },
    ]);

    expect(steps.filter((s) => s.kind === "tool_call").map((s) => s.toolCall?.name)).toEqual([
      "web_search",
      "read_file",
    ]);
  });

  it("does not add an empty assistant turn to a completion that only called tools and said nothing", async () => {
    const steps = await streamOf([
      {
        message: {
          content: "",
          tool_calls: [{ function: { name: "get_weather", arguments: {} } }],
        },
        done: false,
      },
      { done: true, done_reason: "stop" },
    ]);

    expect(steps.map((s) => s.kind)).toEqual(["tool_call"]);
  });
});

// ── The end of the stream ────────────────────────────────────────────

describe("a response whose last line arrives without a trailing newline", () => {
  it("is still delivered in full — the final chunk is not left stranded in the buffer", async () => {
    const steps = await streamOf(
      [
        { message: { content: "Hel" }, done: false },
        { message: { content: "lo" }, done: false },
        { done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 2 },
      ],
      { trailingNewline: false },
    );

    const assistant = steps.find((s) => s.kind === "assistant");
    expect(assistant?.content).toBe("Hello");
    // The usage figures ride on that final line; losing it is what makes
    // the request-preview panel's reconciliation go unavailable.
    expect(assistant?.usage).toEqual({ inputTokens: 7, outputTokens: 2, stopReason: "stop" });
  });
});
