import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAIResponse } from "../../server/openai-client.js";
import type { ConversationStep } from "../../server/types.js";

afterEach(() => vi.restoreAllMocks());

async function streamFragments(fragments: string[], transportChunkSize?: number) {
  const wire = fragments.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(wire);
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    const size = transportChunkSize ?? bytes.length;
    for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size));
    controller.close();
  } });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
  const deltas: ConversationStep[][] = [];
  const steps = await streamOpenAIResponse({
    config: { id: "test", type: "openai-compat", name: "Test", baseUrl: "https://example.test" },
    model: "model", steps: [], tools: [], onDelta: (steps) => deltas.push(structuredClone(steps)),
  });
  return { steps, deltas };
}

describe("OpenAI reasoning delimiter streaming", () => {
  const splits = Array.from({ length: 6 }, (_, i) => i + 1).flatMap((open) =>
    Array.from({ length: 7 }, (_, i) => [open, i + 1] as const));
  it.each(splits)("handles opening split %i and closing split %i without leaking reasoning", async (open, close) => {
    const opening = "<think>", closing = "</think>";
    const { steps, deltas } = await streamFragments([
      "before" + opening.slice(0, open), opening.slice(open) + "private" + closing.slice(0, close), closing.slice(close) + "after",
    ]);
    expect(steps.find((s) => s.kind === "assistant")?.content).toBe("beforeafter");
    expect(steps.find((s) => s.kind === "reasoning")?.content).toBe("private");
    expect(deltas.flat().filter((s) => s.kind === "assistant").every((s) => !s.content.includes("private") && !s.content.includes("<think>"))).toBe(true);
  });

  it("handles character-sized fragments, multiple regions and UTF-8 transport splits", async () => {
    const { steps } = await streamFragments(Array.from("A<think>gründlich</think>B<think>more</think>C"), 1);
    expect(steps.find((s) => s.kind === "assistant")?.content).toBe("ABC");
    expect(steps.find((s) => s.kind === "reasoning")?.content).toBe("gründlichmore");
  });

  it.each([
    ["plain < text <thi", "assistant", "plain < text <thi"],
    ["<think>reasoning</thi", "reasoning", "reasoning</thi"],
    ["<think>x</think>answer <", "assistant", "answer <"],
    ["a<think>x</think>b<think>y</think>c", "assistant", "abc"],
  ])("preserves ordinary text and incomplete EOF prefixes: %s", async (input, kind, expected) => {
    const { steps } = await streamFragments([input]);
    expect(steps.find((s) => s.kind === kind)?.content).toBe(expected);
  });
});

describe("OpenAI final tool arguments", () => {
  it.each(['{"url":', "null", "[]", "true", "42", '"text"'])("rejects non-executable final arguments %s", async (argumentsText) => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "curl", arguments: argumentsText } }] }, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const delta = vi.fn();
    await expect(streamOpenAIResponse({ config: { id: "test", type: "openai-compat", name: "Test", baseUrl: "https://example.test" }, model: "model", steps: [], tools: [], onDelta: delta }))
      .rejects.toThrow("Invalid arguments for tool curl: expected a complete JSON object");
    expect(delta).toHaveBeenCalled(); // provisional display still works before final validation
  });

  it("accepts a fragmented object only after its final closing delimiter arrives", async () => {
    const body = ['{"url":', '"https://example.com"}'].map((argumentsText, index) =>
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { ...(index === 0 ? { name: "curl" } : {}), arguments: argumentsText } }] } }] })}\n\n`).join("");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const steps = await streamOpenAIResponse({ config: { id: "test", type: "openai-compat", name: "Test", baseUrl: "https://example.test" }, model: "model", steps: [], tools: [], onDelta: () => {} });
    expect(steps[0].toolCall).toEqual({ id: "call-1", name: "curl", arguments: { url: "https://example.com" } });
  });
});

describe("OpenAI-compatible request body (AC-CTX-6)", () => {
  it("asks for stream usage and never carries num_ctx", async () => {
    await streamFragments(["hi"]);
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(JSON.stringify(body)).not.toContain("num_ctx");
  });
});

describe("stream_options fallback for strict providers", () => {
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
  const rejection = (message: string, status = 400) =>
    new Response(JSON.stringify({ error: { message } }), { status, headers: { "Content-Type": "application/json" } });
  // Stub provider: rejects any body containing stream_options with `rejectWith`, otherwise streams.
  function stubProvider(rejectWith: () => Response) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      String((init as RequestInit).body).includes("stream_options") ? rejectWith() : new Response(sse));
  }
  const run = (baseUrl: string) => streamOpenAIResponse({
    config: { id: "t", type: "openai-compat", name: "Test", baseUrl }, model: "model", steps: [], tools: [], onDelta: () => {},
  });
  const bodies = () => vi.mocked(globalThis.fetch).mock.calls.map(([, init]) => String((init as RequestInit).body));

  it("retries exactly once without stream_options, then omits it for later requests to the same base URL", async () => {
    stubProvider(() => rejection("Unrecognized request argument supplied: stream_options"));
    const steps = await run("https://strict-a.test");
    expect(steps.find((s) => s.kind === "assistant")?.content).toBe("ok");
    expect(bodies().map((b) => b.includes("stream_options"))).toEqual([true, false]);

    await run("https://strict-a.test");
    expect(bodies().map((b) => b.includes("stream_options"))).toEqual([true, false, false]);

    // Remembered per base URL only: another provider still gets asked for usage first.
    await run("https://strict-b.test");
    expect(bodies().map((b) => b.includes("stream_options"))).toEqual([true, false, false, true, false]);
  });

  it("also recognises include_usage in the error body", async () => {
    stubProvider(() => rejection("unknown field include_usage", 422));
    await run("https://strict-c.test");
    expect(bodies().map((b) => b.includes("stream_options"))).toEqual([true, false]);
  });

  it("does not retry other 4xx errors, 5xx errors or a rejection that does not mention the field", async () => {
    for (const [url, response] of [
      ["https://other-a.test", () => rejection("invalid api key", 401)],
      ["https://other-b.test", () => rejection("model not found", 400)],
      ["https://other-c.test", () => rejection("stream_options overloaded", 500)],
    ] as const) {
      vi.restoreAllMocks();
      stubProvider(response);
      await expect(run(url)).rejects.toThrow("request failed");
      expect(bodies()).toHaveLength(1);
    }
  });

  it("fails after a single retry when the retry is rejected too", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => rejection("bad stream_options"));
    await expect(run("https://strict-d.test")).rejects.toThrow("request failed: 400");
    expect(bodies()).toHaveLength(2);
  });

  it.each([401, 403, 429])("does not treat HTTP %i as a field rejection even if the body names stream_options", async (status) => {
    const url = `https://auth-${status}.test`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => rejection("stream_options include_usage", status));
    await expect(run(url)).rejects.toThrow(`request failed: ${status}`);
    expect(bodies()).toHaveLength(1);
    // Not remembered: a later request still asks for usage.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(sse));
    await run(url);
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).toContain("stream_options");
  });

  it("does not remember a provider whose retry without stream_options also fails", async () => {
    const url = "https://failing-retry.test";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => rejection("bad stream_options"));
    await expect(run(url)).rejects.toThrow("request failed: 400");
    vi.restoreAllMocks();
    stubProvider(() => rejection("bad stream_options"));
    await run(url);
    expect(bodies().map((b) => b.includes("stream_options"))).toEqual([true, false]);
  });
});

describe("bounded error-body read and empty streams", () => {
  it("fails promptly with the original status error when a 4xx body never closes", async () => {
    vi.useFakeTimers();
    try {
      const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("partial")); } });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stalled, { status: 400 }));
      const result = expect(streamOpenAIResponse({
        config: { id: "t", type: "openai-compat", name: "Test", baseUrl: "https://stalled.test" }, model: "m", steps: [], tools: [], onDelta: () => {},
      })).rejects.toThrow("Test request failed: 400");
      await vi.advanceTimersByTimeAsync(2500);
      await result;
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty successful stream yields no steps (no content-free usage step)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("data: [DONE]\n\n"));
    const steps = await streamOpenAIResponse({
      config: { id: "t", type: "openai-compat", name: "Test", baseUrl: "https://empty.test" }, model: "m", steps: [], tools: [], onDelta: () => {},
    });
    expect(steps).toEqual([]);
  });
});
