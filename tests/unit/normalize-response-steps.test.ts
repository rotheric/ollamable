import { describe, expect, it } from "vitest";
import { normalizeResponseSteps } from "../../shared/normalize-response-steps";
import { toOpenAIMessages } from "../../shared/openai-format";
import { toOllamaMessages } from "../../shared/ollama-format";
import type { ConversationStep } from "../../src/types/chat";

const call = { id: "call-1", name: "curl", arguments: { url: "https://example.test" } };
const source: ConversationStep = { id: "legacy", kind: "assistant", title: "Assistant", createdAt: "2026-09-26", content: "", toolCalls: [call], usage: { inputTokens: 12, outputTokens: 7 } };

describe("legacy assistant response migration", () => {
  it.each(["", "Authentic explanation"])("separates calls from prose %j with stable IDs and one usage record", (content) => {
    const steps = normalizeResponseSteps([{ ...source, content }]);
    expect(steps.filter((s) => s.kind === "assistant").map((s) => s.content)).toEqual(content ? [content] : []);
    expect(steps.filter((s) => s.kind === "tool_call").map((s) => s.toolCall)).toEqual([call]);
    expect(steps.filter((s) => s.usage).map((s) => s.usage)).toEqual([source.usage]);
    expect(normalizeResponseSteps(steps)).toEqual(steps);
    const result: ConversationStep = { id: "result", kind: "tool_result", title: "Result", content: "OK", createdAt: source.createdAt, toolResult: { id: call.id, name: call.name } };
    const history = [...steps, result];
    expect(toOpenAIMessages(history)).toEqual([
      { role: "assistant", content, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
      { role: "tool", content: "OK", tool_call_id: call.id },
    ]);
    expect(toOllamaMessages(history)).toEqual([
      { role: "assistant", content, tool_calls: [{ function: { name: call.name, arguments: call.arguments } }] },
      { role: "tool", content: "OK", tool_name: call.name },
    ]);
  });
  it("retains empty response accounting as metadata, with no fake assistant", () => {
    expect(normalizeResponseSteps([{ ...source, toolCalls: undefined }])).toMatchObject([{ kind: "meta", usage: source.usage }]);
  });
});
