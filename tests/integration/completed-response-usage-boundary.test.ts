import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOllamaResponse } from "../../server/ollama-client.js";
import { streamOpenAIResponse } from "../../server/openai-client.js";
import { lastUsedTokens } from "../../shared/context-usage.js";
import type { ConversationStep } from "../../server/types.js";

afterEach(() => vi.restoreAllMocks());

const earlier: ConversationStep[] = [
  { id: "u1", kind: "user", title: "User", content: "hi", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "a1", kind: "assistant", title: "Assistant", content: "hello", createdAt: "2026-01-01T00:00:01.000Z", usage: { inputTokens: 1000, outputTokens: 50 } },
  { id: "u2", kind: "user", title: "User", content: "use a tool", createdAt: "2026-01-01T00:00:02.000Z" },
];
const toolResult: ConversationStep = { id: "r1", kind: "tool_result", title: "Tool Result", content: "x", createdAt: "2026-01-01T00:00:03.000Z", toolResult: { name: "curl", content: "x" } } as ConversationStep;

/** A completed tool-only response that reports neither token counts nor a finish/done reason. */
async function openAiToolOnlyWithoutUsage() {
  const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "curl", arguments: "{}" } }] } }] };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`));
  return streamOpenAIResponse({ config: { id: "t", type: "openai-compat", name: "T", baseUrl: "https://usage-boundary.test" }, model: "m", steps: earlier, tools: [], onDelta: () => {} });
}
async function ollamaToolOnlyWithoutUsage() {
  const line = JSON.stringify({ message: { tool_calls: [{ function: { name: "curl", arguments: {} } }] }, done: true });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`${line}\n`));
  return streamOllamaResponse({ model: "m", steps: earlier, tools: [], onDelta: () => {} });
}

describe.each([
  ["OpenAI-compatible", openAiToolOnlyWithoutUsage],
  ["Ollama", ollamaToolOnlyWithoutUsage],
])("%s completed response that reports nothing", (_name, respond) => {
  it("is a boundary: used tokens are unknown, not the earlier response's figure", async () => {
    const response = await respond();
    expect(response[0].kind).toBe("tool_call");
    expect(response[0].usage).toEqual({});
    const history = [...earlier, ...response, toolResult];
    expect(lastUsedTokens(history)).toBeUndefined();
  });
});

describe("Ollama empty successful stream", () => {
  it("yields no steps (no content-free usage step)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`${JSON.stringify({ message: {}, done: true })}\n`));
    expect(await streamOllamaResponse({ model: "m", steps: earlier, tools: [], onDelta: () => {} })).toEqual([]);
  });
});
