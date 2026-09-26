import { describe, it, expect } from "vitest";
import { tourSteps, createTourConversations } from "@/src/lib/tour-data";
import type { ToolDefinition } from "@/src/types/chat";

const testTools: ToolDefinition[] = [
  {
    id: "web-search",
    name: "web_search",
    description: "Searches the web",
    inputSchema: JSON.stringify({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    }),
  },
];

describe("tourSteps", () => {
  it("has exactly 11 steps", () => {
    expect(tourSteps).toHaveLength(11);
  });

  it("all step targets are valid data-tour selector strings", () => {
    for (const step of tourSteps) {
      expect(step.target).toMatch(/^\[data-tour="[a-z-]+"]/);
    }
  });

  it("all steps have a title string and content string", () => {
    for (const step of tourSteps) {
      expect(typeof step.title).toBe("string");
      expect((step.title as string).length).toBeGreaterThan(0);
      expect(typeof step.content).toBe("string");
      expect((step.content as string).length).toBeGreaterThan(0);
    }
  });
});

describe("createTourConversations", () => {
  it("returns 1 conversation", () => {
    const convos = createTourConversations("test-model", []);
    expect(convos).toHaveLength(1);
  });

  it("sets model to the provided value", () => {
    const convos = createTourConversations("test-model", []);
    expect(convos[0].model).toBe("test-model");
  });

  it("conversation has _tourExample: true", () => {
    const convos = createTourConversations("test-model", []);
    expect(convos[0]._tourExample).toBe(true);
  });

  it("conversation has 8 steps with correct kinds", () => {
    const convos = createTourConversations("test-model", []);
    const steps = convos[0].steps;
    expect(steps).toHaveLength(8);
    expect(steps.map((s) => s.kind)).toEqual([
      "system",
      "user",
      "meta",
      "tool_call",
      "meta",
      "tool_result",
      "reasoning",
      "assistant",
    ]);
  });

  it("user and assistant steps have non-empty content", () => {
    const convos = createTourConversations("test-model", []);
    for (const step of convos[0].steps) {
      if (step.kind === "user" || step.kind === "assistant") {
        expect(step.content.length).toBeGreaterThan(0);
      }
    }
  });

  it("assistant step has usage metadata", () => {
    const convos = createTourConversations("test-model", []);
    const assistantStep = convos[0].steps.find((s) => s.kind === "assistant");
    expect(assistantStep?.usage).toBeDefined();
    expect(assistantStep?.usage?.inputTokens).toBeGreaterThan(0);
    expect(assistantStep?.usage?.outputTokens).toBeGreaterThan(0);
    expect(assistantStep?.usage?.stopReason).toBe("stop");
  });

  it("has correct title and settings", () => {
    const convos = createTourConversations("test-model", []);
    const convo = convos[0];
    expect(convo.title).toBe("Search for the latest SpaceX launch");
    expect(convo.titleEdited).toBe(false);
    expect(convo.temperature).toBe(0.3);
    expect(convo.maxOutputTokens).toBe(1000);
  });

  it("includes web_search tool ID when available", () => {
    const convos = createTourConversations("test-model", testTools);
    expect(convos[0].activeToolIds).toContain("web-search");
  });

  it("has empty activeToolIds when no tools provided", () => {
    const convos = createTourConversations("test-model", []);
    expect(convos[0].activeToolIds).toEqual([]);
  });

  it("has meta steps with metaEvent payloads", () => {
    const convos = createTourConversations("test-model", []);
    const metaSteps = convos[0].steps.filter((s) => s.kind === "meta");
    expect(metaSteps).toHaveLength(2);
    expect(metaSteps[0].metaEvent?.kind).toBe("search_start");
    expect(metaSteps[1].metaEvent?.kind).toBe("search_result");
    expect(metaSteps[1].metaEvent?.durationMs).toBe(420);
  });

  it("has a tool_call step with toolCall payload", () => {
    const convos = createTourConversations("test-model", []);
    const toolCallStep = convos[0].steps.find((s) => s.kind === "tool_call");
    expect(toolCallStep?.toolCall).toBeDefined();
    expect(toolCallStep?.toolCall?.name).toBe("web_search");
  });

  it("has a tool_result step with toolResult payload", () => {
    const convos = createTourConversations("test-model", []);
    const toolResultStep = convos[0].steps.find(
      (s) => s.kind === "tool_result"
    );
    expect(toolResultStep?.toolResult).toBeDefined();
    expect(toolResultStep?.toolResult?.name).toBe("web_search");
  });
});
