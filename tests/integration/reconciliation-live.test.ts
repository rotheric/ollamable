/**
 * tests/integration/reconciliation-live.test.ts — AC-TOK-5 (live-gated),
 * epic-token-view story S4.
 *
 * Runs under vitest.server.config.ts (node env), gated by the same
 * AC-ERR-3 mechanism as AC-TOK-1 (tests/integration/tokenizer.test.ts) —
 * closed (host unreachable, or the fixture model isn't pulled) means this
 * test reports SKIPPED, never failed and never passed.
 *
 * For a conversation of one system message and one user message (no tool
 * calls), asserts:
 *   1. The computed content-token count (tokenize() over
 *      toOllamaFilteredMessages(steps) — the production S4 filtering
 *      function, imported directly rather than reimplemented here) is
 *      STRICTLY LESS than the prompt_eval_count Ollama reports for the
 *      real chat request built from those same steps.
 *   2. The chat request sent for that comparison is built via
 *      server/ollama-client.ts's own `buildOllamaChatBody` (the real
 *      `toOllamaMessages`), never a hand-rolled request body — so the
 *      prompt_eval_count oracle reflects exactly what production sends.
 *
 * The difference (promptEvalCount - contentTokenCount) is, by AC-TOK-5's
 * own definition, the model's rendered template scaffolding — there is
 * no independent oracle for that figure alone (Ollama exposes no
 * "template token count" endpoint), so the discriminating assertion here
 * is the strict inequality: a buggy computation that double-counts, or
 * that accidentally includes the assistant step itself (steps[0..i), not
 * steps[0..i]), would not reliably produce a smaller count.
 */

import { describe, it, expect } from "vitest";
import { tokenize } from "../../server/tokenizer.js";
import { buildOllamaChatBody } from "../../server/ollama-client.js";
import { toOllamaFilteredMessages } from "../../src/lib/token-view.js";
import { checkLiveGate, tokenizerLiveOllamaUrl } from "./tokenizer-live-gate.js";

const MODEL = "qwen3:1.7b";

describe("AC-TOK-5 (live-gated): computed content-token count is strictly less than prompt_eval_count, difference is the template's overhead", () => {
  it("skips cleanly (never fails) when the live gate is closed; runs for real when open", async (ctx) => {
    const baseUrl = tokenizerLiveOllamaUrl();
    const gate = await checkLiveGate(baseUrl, MODEL);

    if (!gate.open) {
      ctx.skip(`live gate closed: ${gate.reason}`);
      return;
    }

    const steps = [
      { id: "system-1", kind: "system" as const, title: "System Prompt", content: "You are a terse assistant.", createdAt: new Date().toISOString() },
      { id: "user-1", kind: "user" as const, title: "User", content: "What is the capital of France?", createdAt: new Date().toISOString() },
    ];

    // steps[0..i) with i === steps.length here: no assistant step exists
    // yet in this fixture (this test builds the request itself rather
    // than replaying a captured completion), so the full two-step slice
    // IS steps[0..i) for the completion this test is about to request.
    const messages = toOllamaFilteredMessages(steps);
    let contentTokenCount = 0;
    for (const message of messages) {
      if (!message.content) continue;
      const result = await tokenize(baseUrl, MODEL, message.content);
      contentTokenCount += result.tokens.length;
    }

    const body = buildOllamaChatBody({ model: MODEL, steps, tools: [], stream: false });
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseBody = (await response.json()) as { prompt_eval_count?: number };
    const promptEvalCount = responseBody.prompt_eval_count;

    expect(typeof promptEvalCount).toBe("number");
    expect(contentTokenCount).toBeLessThan(promptEvalCount!);

    const overhead = promptEvalCount! - contentTokenCount;
    expect(overhead).toBeGreaterThan(0);
  });
});
