import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { HttpInputError, readJsonBody, validateChatRequest } from "../../server/request-validation.js";

function chatSend(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "chat.send", conversationId: "c1", model: "m", steps: [], tools: [], ...extra };
}

describe("validateChatRequest context fields (AC-CTX-9)", () => {
  it("accepts a request without them and with valid ones", () => {
    expect(validateChatRequest(chatSend())).toBeUndefined();
    for (const source of ["runtime", "modelfile", "estimated", "assumed"]) {
      expect(validateChatRequest(chatSend({ contextWindow: 4096, contextWindowSource: source, modelFamily: "qwen3" }))).toBeUndefined();
    }
  });

  it.each([0, -1, 1.5, "4096", null, Number.NaN, Infinity, {}])("rejects contextWindow %j", (contextWindow) => {
    expect(validateChatRequest(chatSend({ contextWindow }))).toBe("Invalid contextWindow");
  });

  it.each(["", "Runtime", "live", 1, null, {}])("rejects contextWindowSource %j", (contextWindowSource) => {
    expect(validateChatRequest(chatSend({ contextWindowSource }))).toBe("Invalid contextWindowSource");
  });

  it.each(["", "   ", 1, null, {}])("rejects modelFamily %j", (modelFamily) => {
    expect(validateChatRequest(chatSend({ modelFamily }))).toBe("Invalid modelFamily");
  });
});

describe("validateChatRequest compaction steps (AC-FORK-9)", () => {
  const compaction = { id: "s1", kind: "compaction", title: "Compaction", content: "summary", createdAt: "2026-01-01T00:00:00.000Z" };

  it("accepts a chat.send whose steps contain a compaction step", () => {
    expect(validateChatRequest(chatSend({ steps: [compaction] }))).toBeUndefined();
  });

  it.each([{ kind: "Compaction" }, { content: undefined }, { id: "" }])("still rejects a malformed one %j", (patch) => {
    expect(validateChatRequest(chatSend({ steps: [{ ...compaction, ...patch }] }))).toBeDefined();
  });
});

describe("validateChatRequest: every field is checked on its own (mutation audit)", () => {
  // A request in which every optional field is present and valid, so each corruption below is the
  // ONLY defect and its rejection can be attributed to the one guard under test.
  const tool = { id: "t1", name: "web_search", description: "d", inputSchema: '{"type":"object"}' };
  const at = "2026-01-01T00:00:00.000Z";
  const valid = (): Record<string, unknown> => ({
    type: "chat.send",
    conversationId: "c1",
    requestId: "r1",
    model: "m",
    provider: "ollama",
    steps: [
      { id: "s1", kind: "user", title: "User", content: "hi", createdAt: at },
      { id: "s2", kind: "tool_call", title: "Call", content: "", createdAt: at, toolCall: { id: "k1", name: "web_search", arguments: { q: "x" } } },
      { id: "s3", kind: "assistant", title: "A", content: "", createdAt: at, toolCalls: [{ name: "web_search", arguments: {} }] },
      { id: "s4", kind: "tool_result", title: "Result", content: "r", createdAt: at, toolResult: { id: "k1", name: "web_search" } },
    ],
    tools: [tool],
    temperature: 0.7,
    maxOutputTokens: 1,
    reasoningEffort: "low",
    maxModelInvocations: 1,
    maxToolCalls: 1,
    contextWindow: 1,
    contextWindowSource: "runtime",
    modelFamily: "qwen3",
  });
  const withStep = (index: number, patch: Record<string, unknown>) => {
    const request = valid();
    const steps = request.steps as Record<string, unknown>[];
    steps[index] = { ...steps[index], ...patch };
    return request;
  };

  it("accepts the fully populated request, at every lower bound and for every step kind and effort", () => {
    expect(validateChatRequest(valid())).toBeUndefined();
    for (const kind of ["system", "user", "assistant", "reasoning", "tool_call", "tool_result", "meta", "compaction"]) {
      expect(validateChatRequest({ ...valid(), steps: [{ id: "s", kind, title: "t", content: "", createdAt: at }] })).toBeUndefined();
    }
    for (const reasoningEffort of ["disable", "low", "medium", "high"]) {
      expect(validateChatRequest({ ...valid(), reasoningEffort })).toBeUndefined();
    }
    expect(validateChatRequest({ ...valid(), temperature: 0 })).toBeUndefined();
  });

  it.each<[string, () => Record<string, unknown>, string]>([
    ["empty requestId", () => ({ ...valid(), requestId: "" }), "Invalid conversationId or requestId"],
    ["numeric requestId", () => ({ ...valid(), requestId: 5 }), "Invalid conversationId or requestId"],
    ["blank provider", () => ({ ...valid(), provider: " " }), "Invalid model or provider"],
    ["non-string step title", () => withStep(0, { title: 5 }), "Invalid conversation steps"],
    ["non-string step createdAt", () => withStep(0, { createdAt: 5 }), "Invalid conversation steps"],
    ["toolCall with a blank name", () => withStep(1, { toolCall: { name: " ", arguments: {} } }), "Invalid conversation steps"],
    ["toolCall with an empty id", () => withStep(1, { toolCall: { id: "", name: "n", arguments: {} } }), "Invalid conversation steps"],
    ["toolCall with string arguments", () => withStep(1, { toolCall: { name: "n", arguments: "{}" } }), "Invalid conversation steps"],
    ["toolCall with array arguments", () => withStep(1, { toolCall: { name: "n", arguments: [] } }), "Invalid conversation steps"],
    ["toolCalls that is not an array", () => withStep(2, { toolCalls: { name: "n", arguments: {} } }), "Invalid conversation steps"],
    ["toolCalls with one malformed entry", () => withStep(2, { toolCalls: [{ name: "n", arguments: {} }, { name: "", arguments: {} }] }), "Invalid conversation steps"],
    ["toolResult that is not a record", () => withStep(3, { toolResult: "web_search" }), "Invalid conversation steps"],
    ["toolResult with an empty name", () => withStep(3, { toolResult: { name: "" } }), "Invalid conversation steps"],
    ["toolResult with an empty id", () => withStep(3, { toolResult: { id: "", name: "n" } }), "Invalid conversation steps"],
    ["tool with a non-string description", () => ({ ...valid(), tools: [{ ...tool, description: 1 }] }), "Invalid tool definitions"],
    ["tool with a non-string inputSchema", () => ({ ...valid(), tools: [{ ...tool, inputSchema: {} }] }), "Invalid tool definitions"],
    ["tool with an unparseable inputSchema", () => ({ ...valid(), tools: [{ ...tool, inputSchema: "{" }] }), "Invalid tool definitions"],
    ["tool with a non-object inputSchema", () => ({ ...valid(), tools: [{ ...tool, inputSchema: "[]" }] }), "Invalid tool definitions"],
    ["two tools sharing an id", () => ({ ...valid(), tools: [tool, { ...tool, name: "other" }] }), "Duplicate tool names or IDs"],
    ["two tools sharing a name", () => ({ ...valid(), tools: [tool, { ...tool, id: "t2" }] }), "Duplicate tool names or IDs"],
    ["string temperature", () => ({ ...valid(), temperature: "0.7" }), "Invalid temperature"],
    ["NaN temperature", () => ({ ...valid(), temperature: Number.NaN }), "Invalid temperature"],
    ["string maxOutputTokens", () => ({ ...valid(), maxOutputTokens: "5" }), "Invalid maxOutputTokens"],
    ["fractional maxOutputTokens", () => ({ ...valid(), maxOutputTokens: 1.5 }), "Invalid maxOutputTokens"],
    ["zero maxOutputTokens", () => ({ ...valid(), maxOutputTokens: 0 }), "Invalid maxOutputTokens"],
    ["unknown reasoningEffort", () => ({ ...valid(), reasoningEffort: "max" }), "Invalid reasoningEffort"],
    ["string maxModelInvocations", () => ({ ...valid(), maxModelInvocations: "3" }), "Invalid maxModelInvocations"],
    ["string maxToolCalls", () => ({ ...valid(), maxToolCalls: "3" }), "Invalid maxToolCalls"],
  ])("rejects %s with its own message", (_name, build, message) => {
    expect(validateChatRequest(build())).toBe(message);
  });
});

describe("readJsonBody (in-process, mutation audit)", () => {
  // A minimal IncomingMessage double: an EventEmitter with headers and pause(), driven by the test.
  function request(headers: Record<string, string> = {}) {
    const emitter = new EventEmitter() as EventEmitter & { headers: Record<string, string>; pause: () => void; paused: boolean };
    emitter.headers = headers;
    emitter.paused = false;
    emitter.pause = () => { emitter.paused = true; };
    return emitter;
  }
  const asReq = (r: ReturnType<typeof request>) => r as unknown as IncomingMessage;

  it("parses a body delivered in several chunks and detaches its listeners", async () => {
    const req = request();
    const body = readJsonBody(asReq(req));
    req.emit("data", Buffer.from('{"a":'));
    req.emit("data", Buffer.from('"é"}'));
    req.emit("end");
    await expect(body).resolves.toEqual({ a: "é" });
    for (const event of ["data", "end", "error", "aborted"]) expect(req.listenerCount(event)).toBe(0);
  });

  it("accepts a body of exactly maxBytes and rejects one byte more with 413, pausing the upload", async () => {
    const exact = request();
    const ok = readJsonBody(asReq(exact), 4);
    exact.emit("data", Buffer.from('"ab"'));
    exact.emit("end");
    await expect(ok).resolves.toBe("ab");

    const over = request();
    const tooBig = readJsonBody(asReq(over), 4);
    over.emit("data", Buffer.from('"abc"'));
    await expect(tooBig).rejects.toMatchObject({ status: 413, message: "Request body exceeds 64 KiB" });
    expect(over.paused).toBe(true);
    expect(over.listenerCount("data")).toBe(0);
  });

  it("counts bytes across chunks", async () => {
    const req = request();
    const body = readJsonBody(asReq(req), 4);
    req.emit("data", Buffer.from('"a'));
    req.emit("data", Buffer.from('bc"'));
    await expect(body).rejects.toMatchObject({ status: 413 });
  });

  it("rejects a declared content-length above the limit before reading, but not one at the limit", async () => {
    await expect(readJsonBody(asReq(request({ "content-length": "5" })), 4)).rejects.toMatchObject({ status: 413, message: "Request body exceeds 64 KiB" });
    const atLimit = request({ "content-length": "4" });
    const ok = readJsonBody(asReq(atLimit), 4);
    atLimit.emit("data", Buffer.from('"ab"'));
    atLimit.emit("end");
    await expect(ok).resolves.toBe("ab");
  });

  it("defaults the limit to 64 KiB", async () => {
    await expect(readJsonBody(asReq(request({ "content-length": String(64 * 1024 + 1) })))).rejects.toMatchObject({ status: 413 });
    const req = request({ "content-length": String(64 * 1024) });
    const body = readJsonBody(asReq(req));
    req.emit("data", Buffer.from("1"));
    req.emit("end");
    await expect(body).resolves.toBe(1);
  });

  it.each<[string, (req: EventEmitter) => void, number, string]>([
    ["invalid JSON", (req) => { req.emit("data", Buffer.from("{")); req.emit("end"); }, 400, "Invalid JSON body"],
    ["an upload error", (req) => req.emit("error", new Error("reset")), 400, "Request upload failed"],
    ["an aborted upload", (req) => req.emit("aborted"), 400, "Request upload aborted"],
  ])("rejects %s with its own status and message", async (_name, act, status, message) => {
    const req = request();
    const body = readJsonBody(asReq(req));
    act(req);
    await expect(body).rejects.toMatchObject({ status, message });
    await expect(body).rejects.toBeInstanceOf(HttpInputError);
    for (const event of ["data", "end", "error", "aborted"]) expect(req.listenerCount(event)).toBe(0);
  });

  it("times out a stalled upload with 408 after 10 seconds, not before", async () => {
    vi.useFakeTimers();
    try {
      const req = request();
      const body = readJsonBody(asReq(req));
      const settled = vi.fn();
      body.then(settled, settled);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(body).rejects.toMatchObject({ status: 408, message: "Request upload timed out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a completed body clears its timer, so it never times out afterwards", async () => {
    vi.useFakeTimers();
    try {
      const req = request();
      const body = readJsonBody(asReq(req));
      req.emit("data", Buffer.from("2"));
      req.emit("end");
      await expect(body).resolves.toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
