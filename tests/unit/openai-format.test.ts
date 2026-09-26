import { describe, it, expect } from "vitest";
import { buildOpenAIRequestBody, type FormatStep, type FormatTool } from "@/shared/openai-format";

const userStep: FormatStep = {
  kind: "user",
  content: "Hello",
};

const noTools: FormatTool[] = [];

describe("buildOpenAIRequestBody", () => {
  it("includes model and messages by default without optional fields", () => {
    const body = buildOpenAIRequestBody({
      model: "qwen3:latest",
      steps: [userStep],
      tools: noTools,
    });

    expect(body.model).toBe("qwen3:latest");
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("includes temperature and max_tokens when provided", () => {
    const body = buildOpenAIRequestBody({
      model: "qwen3:latest",
      steps: [userStep],
      tools: noTools,
      temperature: 0.6,
      maxOutputTokens: 250,
    });

    expect(body.temperature).toBe(0.6);
    expect(body.max_tokens).toBe(250);
  });

  it("includes reasoning_effort as a top-level field when provided", () => {
    const body = buildOpenAIRequestBody({
      model: "o1",
      steps: [userStep],
      tools: noTools,
      reasoningEffort: "high",
    });

    expect(body.reasoning_effort).toBe("high");
  });

  it.each(["low", "medium", "high"] as const)(
    "round-trips reasoning effort value '%s'",
    (effort) => {
      const body = buildOpenAIRequestBody({
        model: "o1",
        steps: [userStep],
        tools: noTools,
        reasoningEffort: effort,
      });

      expect(body.reasoning_effort).toBe(effort);
    }
  );

  it("maps 'disable' to OpenAI's 'minimal' reasoning level", () => {
    const body = buildOpenAIRequestBody({
      model: "gpt-5",
      steps: [userStep],
      tools: noTools,
      reasoningEffort: "disable",
    });

    expect(body.reasoning_effort).toBe("minimal");
  });

  it("omits reasoning_effort when not provided", () => {
    const body = buildOpenAIRequestBody({
      model: "o1",
      steps: [userStep],
      tools: noTools,
    });

    expect(body).not.toHaveProperty("reasoning_effort");
  });
});
