/**
 * Congruence test for shared/ollama-format.ts's `toOllamaMessages`
 * (epic-token-view S4-F1).
 *
 * Before this file existed, server/ollama-client.ts and
 * src/lib/token-view.ts each hand-kept their own copy of this filtering
 * logic. A Stage-1 review built a congruence harness running both
 * bodies verbatim over five cases and found three diverged: a pending
 * tool call surviving a following non-empty `system` step (case C), a
 * `tool_call` step missing its `toolCall` payload (case D), and a
 * `tool_result` step missing its `toolResult` payload (case E). The fix
 * was to eliminate the duplication rather than patch it: both sides now
 * import the single implementation in shared/ollama-format.ts.
 *
 * This test guards against that duplication being reintroduced. It
 * drives BOTH production entry points — server/ollama-client.ts's
 * `buildOllamaChatBody` (the real outgoing request) and
 * src/lib/token-view.ts's `toOllamaFilteredMessages` (the request-preview
 * panel's source, AC-TOK-5) — over a pinned case table and asserts both
 * reduce to the identical {role, content} sequence. Lives under
 * tests/integration/ (node env) per architecture.md's
 * path-tokenizer-suite-node-env convention, since it imports
 * server/ollama-client.js; tests/integration/reconciliation-live.test.ts
 * is the existing precedent for importing src/lib/token-view.js from
 * this same node-env suite.
 */

import { describe, it, expect } from "vitest";
import { buildOllamaChatBody } from "../../server/ollama-client.js";
import type { ConversationStep } from "../../server/types.js";
import { toOllamaFilteredMessages } from "../../src/lib/token-view.js";

function step(overrides: Partial<ConversationStep> & { kind: ConversationStep["kind"] }): ConversationStep {
  return {
    id: Math.random().toString(36).slice(2),
    title: "",
    content: "",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Case {
  name: string;
  steps: ConversationStep[];
  expected: Array<{ role: string; content: string }>;
}

const cases: Case[] = [
  {
    name: "A — happy path: one system message and one user message, no tool calls (AC-TOK-5's own scoped case)",
    steps: [step({ kind: "system", content: "You are a terse assistant." }), step({ kind: "user", content: "q" })],
    expected: [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: "q" },
    ],
  },
  {
    name: "B — normal tool loop: user, tool_call, tool_result, assistant",
    steps: [
      step({ kind: "user", content: "q" }),
      step({ kind: "tool_call", content: "", toolCall: { name: "get_weather", arguments: {} } }),
      step({ kind: "tool_result", content: "r", toolResult: { name: "get_weather" } }),
      step({ kind: "assistant", content: "final" }),
    ],
    expected: [
      { role: "user", content: "q" },
      { role: "assistant", content: "" },
      { role: "tool", content: "r" },
      { role: "assistant", content: "final" },
    ],
  },
  {
    name: "C — a system step arriving AFTER a pending tool_call flushes it first, rather than dropping it",
    steps: [
      step({ kind: "user", content: "q" }),
      step({ kind: "tool_call", content: "", toolCall: { name: "get_weather", arguments: {} } }),
      step({ kind: "system", content: "sys" }),
      step({ kind: "user", content: "q2" }),
    ],
    expected: [
      { role: "user", content: "q" },
      { role: "assistant", content: "" },
      { role: "system", content: "sys" },
      { role: "user", content: "q2" },
    ],
  },
  {
    name: "D — a tool_call step missing its toolCall payload is not treated as a pending call",
    steps: [
      step({ kind: "user", content: "q" }),
      step({ kind: "tool_call", content: "" }),
      step({ kind: "user", content: "q2" }),
    ],
    expected: [
      { role: "user", content: "q" },
      { role: "user", content: "q2" },
    ],
  },
  {
    name: "E — a tool_result step missing its toolResult payload is dropped entirely",
    steps: [
      step({ kind: "user", content: "q" }),
      step({ kind: "tool_result", content: "r" }),
      step({ kind: "user", content: "q2" }),
    ],
    expected: [
      { role: "user", content: "q" },
      { role: "user", content: "q2" },
    ],
  },
  {
    // F — the MERGED shape the live server actually persists
    // (ws-handler.ts folds every standalone `tool_call` step into the
    // turn's `assistant` step as `toolCalls[]`). This case only pins
    // {role, content} congruence between the two production entry
    // points, matching what this file has always compared — it does
    // NOT exercise `tool_calls[]` fidelity on the wire, because
    // `toOllamaFilteredMessages` deliberately drops that field already
    // (irrelevant to token counting/preview rendering). Both entry
    // points call the identical shared `toOllamaMessages`, so they stay
    // congruent here even though that shared implementation currently
    // drops the merged `toolCalls[]` announcement entirely (epic-
    // token-view gate-remediation finding F4, report-only — see the
    // `it.fails` property in ollama-format-contract.test.ts for where
    // that gap is actually surfaced and documented).
    name: "F — an assistant step already carrying toolCalls[] (merged shape) stays congruent between server and client, even though {role, content} alone can't reveal F4's dropped tool_calls",
    steps: [
      step({ kind: "user", content: "q" }),
      step({ kind: "assistant", content: "", toolCalls: [{ name: "get_weather", arguments: {} }] }),
      step({ kind: "tool_result", content: "r", toolResult: { name: "get_weather" } }),
      step({ kind: "assistant", content: "final" }),
    ],
    expected: [
      { role: "user", content: "q" },
      { role: "assistant", content: "" },
      { role: "tool", content: "r" },
      { role: "assistant", content: "final" },
    ],
  },
];

describe("shared/ollama-format.ts's toOllamaMessages — congruence between the server and client production entry points", () => {
  for (const { name, steps, expected } of cases) {
    it(name, () => {
      const serverMessages = buildOllamaChatBody({ model: "qwen3:latest", steps, tools: [], stream: false })
        .messages as Array<{ role: string; content: string }>;
      const serverRoleContent = serverMessages.map(({ role, content }) => ({ role, content }));
      expect(serverRoleContent).toEqual(expected);

      const clientMessages = toOllamaFilteredMessages(steps);
      expect(clientMessages).toEqual(expected);

      // The point of this test: both production entry points must agree,
      // not just each independently match the pinned table.
      expect(clientMessages).toEqual(serverRoleContent);
    });
  }
});
