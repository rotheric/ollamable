import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOllamaResponse } from "../../server/ollama-client.js";
import { streamOpenAIResponse } from "../../server/openai-client.js";

afterEach(() => vi.restoreAllMocks());

for (const provider of ["ollama", "openai"] as const) {
  describe(`${provider} invocation usage`, () => {
    it.each(["tool_call", "reasoning", "assistant", "empty"])("preserves usage exactly once on a %s response", async (kind) => {
      const usage = { inputTokens: 17, outputTokens: 9, stopReason: "stop" };
      const message = kind === "assistant" ? { content: "Answer" }
        : kind === "reasoning" ? (provider === "ollama" ? { thinking: "Thinking" } : { content: "<think>Thinking</think>" })
        : kind === "tool_call" ? { tool_calls: [{ index: 0, id: "call-1", function: { name: "curl", arguments: provider === "ollama" ? { url: "https://example.test" } : '{"url":"https://example.test"}' } }] }
        : {};
      const wire = provider === "ollama"
        ? JSON.stringify({ message, done: true, prompt_eval_count: 17, eval_count: 9, done_reason: "stop" }) + "\n"
        : `data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 9 } })}\n\ndata: [DONE]\n\n`;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(wire));
      const args = { model: "test", steps: [], tools: [], onDelta: () => {} };
      const steps = provider === "ollama" ? await streamOllamaResponse(args)
        : await streamOpenAIResponse({ ...args, config: { id: "test", type: "openai-compat", name: "Test", baseUrl: "https://example.test" } });
      expect(steps.filter((s) => s.usage).map((s) => s.usage)).toEqual([usage]);
      expect(steps.map((s) => s.kind)).toEqual([kind === "empty" ? "meta" : kind]);
      expect(steps.filter((s) => s.kind === "assistant").every((s) => s.content.trim())).toBe(true);
      expect(JSON.parse(JSON.stringify(steps)).reduce((sum: number, s: { usage?: { outputTokens?: number } }) => sum + (s.usage?.outputTokens ?? 0), 0)).toBe(9);
    });
  });
}
