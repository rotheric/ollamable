/**
 * Output-contract tests for shared/ollama-format.ts's `toOllamaMessages`
 * — the single implementation that decides which conversation steps
 * become outgoing Ollama `/api/chat` messages.
 *
 * Companion to tests/integration/ollama-format-congruence.test.ts, which
 * pins five hand-written cases and asserts the two production entry
 * points agree on them. This file asks the other half of the question:
 * over *arbitrary* conversations, what does the outgoing message list
 * promise its reader? Those promises are what a future refactor of the
 * filter must not break, and they are what a mutation audit found the
 * five-case table does not assert (Stryker survivors at
 * shared/ollama-format.ts L49, L58-L65, L71-L73, L81, L83, L92).
 *
 * AC linkage (plugins/base/skills/property-based-testing/
 * acceptance-criteria-linkage.md):
 *  - The congruence property cites epic-token-view:AC-TOK-5, whose
 *    operative clause is that the preview panel's figure is derived from
 *    the steps "filtered exactly as `toOllamaMessages` filters them".
 *  - The four content properties have NO acceptance criterion:
 *    epic-token-view specifies what the filter is *used for*, never what
 *    it *does*. Paired spec-gap findings are reported by the audit that
 *    produced this file (no BACKLOG.json exists in this project yet —
 *    BACKLOG.md is still the legacy v2 markdown form — so they are
 *    surfaced in the audit summary rather than filed).
 *
 * Determinism: fast-check runs are seeded (`{ seed }` per property) so
 * the test *names* stay stable. Stryker filters the suite by test name;
 * a randomised name breaks its mutant-to-test mapping and every mutant
 * reports as survived.
 *
 * Lives under tests/integration/ (node env) for the same reason the
 * congruence test does: it imports server/ollama-client.js.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildOllamaChatBody } from "../../server/ollama-client.js";
import type { ConversationStep, StepKind } from "../../server/types.js";
import { toOllamaFilteredMessages } from "../../src/lib/token-view.js";

const SEED = 42;
const RUNS = 300;

interface OutgoingMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

/** Drives the real production entry point — the body actually sent to Ollama. */
function outgoing(steps: ConversationStep[]): OutgoingMessage[] {
  return buildOllamaChatBody({ model: "qwen3:latest", steps, tools: [], stream: false })
    .messages as OutgoingMessage[];
}

// ── Generators ───────────────────────────────────────────────────────
//
// The generators describe the shape of a *conversation*, not the shape
// of the filter's branches: any transcript the app can persist is fair
// game, including the malformed-payload steps that a crashed tool round
// trip leaves behind (a `tool_call` step whose call never materialised,
// a `tool_result` step whose result never arrived). Those are exactly
// the shapes that diverged between the two hand-kept copies before this
// module existed.

const contentArb = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("\n\t "),
  fc.string({ minLength: 1, maxLength: 12 }),
);

const toolNameArb = fc.constantFrom("get_weather", "web_search", "read_file");
const argumentsArb = fc.dictionary(fc.constantFrom("q", "city", "path"), fc.string({ maxLength: 6 }), {
  maxKeys: 2,
});

let nextId = 0;
function makeStep(kind: StepKind, content: string, extra: Partial<ConversationStep> = {}): ConversationStep {
  return {
    id: `s${nextId++}`,
    kind,
    title: "",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

const stepArb: fc.Arbitrary<ConversationStep> = fc.oneof(
  // Plain conversation steps.
  fc
    .tuple(fc.constantFrom<StepKind>("system", "user", "assistant", "reasoning", "meta"), contentArb)
    .map(([kind, content]) => makeStep(kind, content)),
  // A tool call that completed — carries its payload.
  fc
    .tuple(toolNameArb, argumentsArb, contentArb)
    .map(([name, args, content]) => makeStep("tool_call", content, { toolCall: { name, arguments: args } })),
  // A tool call that never materialised — no payload.
  contentArb.map((content) => makeStep("tool_call", content)),
  // A tool result that arrived — carries its payload.
  fc
    .tuple(toolNameArb, contentArb)
    .map(([name, content]) => makeStep("tool_result", content, { toolResult: { name } })),
  // A tool result that never arrived — no payload.
  contentArb.map((content) => makeStep("tool_result", content)),
  // An assistant step already carrying `toolCalls[]` — the MERGED shape
  // the live server actually persists (ws-handler.ts folds every
  // standalone `tool_call` step into the turn's `assistant` step; see
  // architecture.md's Implementation Constraint 4, and epic-token-view
  // gate-remediation findings F1/F3/F4). Distinct from the legacy
  // standalone `tool_call` step generated above, which tour/example
  // conversations still use.
  fc
    .tuple(fc.array(fc.tuple(toolNameArb, argumentsArb), { minLength: 1, maxLength: 3 }), contentArb)
    .map(([calls, content]) =>
      makeStep("assistant", content, {
        toolCalls: calls.map(([name, args]) => ({ name, arguments: args })),
      })
    ),
);

const conversationArb = fc.array(stepArb, { minLength: 0, maxLength: 12 });

// ── What the outgoing message list promises ──────────────────────────

describe("the outgoing Ollama request built from a conversation", () => {
  it("never carries a blank instruction message — a system step the user left empty is not sent as an empty instruction", () => {
    fc.assert(
      fc.property(conversationArb, (steps) => {
        for (const message of outgoing(steps)) {
          if (message.role === "system") {
            expect(message.content.trim().length).toBeGreaterThan(0);
          }
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("announces every tool the assistant actually called, once each, in the order it called them — and announces no tool it did not call", () => {
    fc.assert(
      fc.property(conversationArb, (steps) => {
        const announced = outgoing(steps)
          .flatMap((message) => message.tool_calls ?? [])
          .map(({ function: fn }) => ({ name: fn.name, arguments: fn.arguments }));

        const actuallyCalled = steps
          .filter((step) => step.kind === "tool_call" && step.toolCall)
          .map((step) => ({ name: step.toolCall!.name, arguments: step.toolCall!.arguments }));

        // SCOPED TO THE LEGACY STANDALONE `tool_call` SHAPE ONLY. The
        // generator also produces the merged `assistant.toolCalls[]` shape
        // that ws-handler actually persists, and toOllamaMessages does not
        // announce those — so `actuallyCalled` deliberately excludes them
        // here. Do NOT read this as "merged calls are meant to be dropped":
        // that gap is a real defect, asserted as such by the `it.fails`
        // property below, and this test will go red alongside it when the
        // gap is closed. Within the legacy shape: no loss (a call left
        // pending at the end of the transcript is still announced), no
        // duplication, no fabrication (a tool_call step whose payload never
        // materialised announces nothing), and name/arguments survive verbatim.
        expect(announced).toEqual(actuallyCalled);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  // EXPECTED FAILURE — epic-token-view gate remediation finding F4,
  // report-only, DO NOT fix the production code to make this pass.
  //
  // `toOllamaMessages` (shared/ollama-format.ts) only ever reads the
  // legacy standalone `tool_call` step; it never reads
  // `step.toolCalls`. Its sibling `toOpenAIMessages`
  // (shared/openai-format.ts) handles both shapes. Since the live
  // server (server/ws-handler.ts) persists ONLY the merged
  // `assistant.toolCalls[]` shape, the real second-iteration request
  // actually sent to Ollama silently drops the tool-call announcement
  // for any turn built from a persisted conversation — this property
  // is the generalised version of the previous one, extended to also
  // treat a merged-shape `assistant` step's `toolCalls[]` as "actually
  // called", and it fails against current production behavior. This is
  // pre-existing wire behavior outside this epic's diff; changing what
  // is sent to Ollama is a separate fix to be filed and made
  // deliberately, not smuggled in here via a property test. `it.fails`
  // keeps this documented and red-if-ever-accidentally-fixed-silently,
  // without blocking the suite.
  it.fails(
    "[F4, report-only] announces every tool call the assistant made, including ones recorded in the merged assistant.toolCalls[] shape the server actually persists",
    () => {
      fc.assert(
        fc.property(conversationArb, (steps) => {
          const announced = outgoing(steps)
            .flatMap((message) => message.tool_calls ?? [])
            .map(({ function: fn }) => ({ name: fn.name, arguments: fn.arguments }));

          const actuallyCalled = steps.flatMap((step) => {
            if (step.kind === "tool_call" && step.toolCall) {
              return [{ name: step.toolCall.name, arguments: step.toolCall.arguments }];
            }
            if (step.kind === "assistant" && step.toolCalls && step.toolCalls.length > 0) {
              return step.toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments }));
            }
            return [];
          });

          expect(announced).toEqual(actuallyCalled);
        }),
        { seed: SEED, numRuns: RUNS },
      );
    },
  );

  it("reports back every tool result the conversation received, once each, in order — and reports none it never received", () => {
    fc.assert(
      fc.property(conversationArb, (steps) => {
        const reported = outgoing(steps)
          .filter((message) => message.role === "tool")
          .map((message) => ({ name: message.tool_name, content: message.content }));

        const actuallyReceived = steps
          .filter((step) => step.kind === "tool_result" && step.toolResult)
          .map((step) => ({ name: step.toolResult!.name, content: step.content }));

        expect(reported).toEqual(actuallyReceived);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("keeps the conversation in the order it happened: what the user and the assistant said comes through in transcript order", () => {
    fc.assert(
      fc.property(conversationArb, (steps) => {
        const spoken = outgoing(steps)
          .filter((message) => message.role === "user" || (message.role === "system" && message.content.trim()))
          .map((message) => ({ role: message.role, content: message.content }));

        const said = steps
          .filter((step) => step.kind === "user" || (step.kind === "system" && step.content.trim().length > 0))
          .map((step) => ({ role: step.kind as string, content: step.content }));

        expect(spoken).toEqual(said);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("shows the request-preview panel exactly the request that gets sent (epic-token-view:AC-TOK-5)", () => {
    fc.assert(
      fc.property(conversationArb, (steps) => {
        // Both production entry points, over arbitrary conversations —
        // the generalisation of the five-case table in
        // ollama-format-congruence.test.ts. This is the guard against
        // the two sides ever being hand-kept separately again.
        //
        // Compared on {role, content}: that is the whole surface the
        // preview panel renders and reconciles against, and the client
        // wrapper deliberately projects the tool-call argument payloads
        // away (they carry no │-separable content — see
        // src/lib/token-view.ts's toOllamaFilteredMessages).
        const sent = outgoing(steps).map(({ role, content }) => ({ role, content }));
        expect(toOllamaFilteredMessages(steps)).toEqual(sent);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

// ── The pending-tool-call handover ───────────────────────────────────
//
// Ollama's chat format requires the assistant's tool-call announcement to
// precede whatever comes next in the transcript. That handover had no
// behavioural test at all (the whole block was NoCoverage), so these are
// the plain feature tests for it rather than properties.

describe("a tool call the assistant made is announced before the conversation moves on", () => {
  it("announces pending calls immediately before the user's next message", () => {
    const steps = [
      makeStep("user", "what is the weather?"),
      makeStep("tool_call", "", { toolCall: { name: "get_weather", arguments: { city: "Berlin" } } }),
      makeStep("user", "actually, never mind"),
    ];

    expect(outgoing(steps)).toEqual([
      { role: "user", content: "what is the weather?" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Berlin" } } }] },
      { role: "user", content: "actually, never mind" },
    ]);
  });

  it("folds the assistant's own words into the same announcement rather than sending two assistant messages", () => {
    const steps = [
      makeStep("user", "q"),
      makeStep("tool_call", "", { toolCall: { name: "web_search", arguments: { q: "x" } } }),
      makeStep("assistant", "let me look that up"),
    ];

    expect(outgoing(steps)).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "let me look that up",
        tool_calls: [{ function: { name: "web_search", arguments: { q: "x" } } }],
      },
    ]);
  });

  it("gathers several calls made back to back into one announcement", () => {
    const steps = [
      makeStep("user", "q"),
      makeStep("tool_call", "", { toolCall: { name: "web_search", arguments: { q: "a" } } }),
      makeStep("tool_call", "", { toolCall: { name: "read_file", arguments: { path: "b" } } }),
      makeStep("user", "q2"),
    ];

    const messages = outgoing(steps);
    expect(messages).toHaveLength(3);
    expect(messages[1].tool_calls).toEqual([
      { function: { name: "web_search", arguments: { q: "a" } } },
      { function: { name: "read_file", arguments: { path: "b" } } },
    ]);
  });

  it("still announces a call the transcript ends on, so an interrupted tool round trip is not silently dropped", () => {
    const steps = [
      makeStep("user", "q"),
      makeStep("tool_call", "", { toolCall: { name: "get_weather", arguments: {} } }),
    ];

    expect(outgoing(steps)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "get_weather", arguments: {} } }] },
    ]);
  });

  it("announces a pending call before the result it belongs to, and does not repeat it afterwards", () => {
    const steps = [
      makeStep("user", "q"),
      makeStep("tool_call", "", { toolCall: { name: "get_weather", arguments: {} } }),
      makeStep("tool_result", "sunny", { toolResult: { name: "get_weather" } }),
      makeStep("assistant", "it is sunny"),
    ];

    expect(outgoing(steps)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "get_weather", arguments: {} } }] },
      { role: "tool", content: "sunny", tool_name: "get_weather" },
      { role: "assistant", content: "it is sunny" },
    ]);
  });
});
