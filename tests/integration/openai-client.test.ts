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
