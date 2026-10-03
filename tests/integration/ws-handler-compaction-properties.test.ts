/**
 * Compaction-tool S7: property tests over the assembled tool loop (AC-STRUCT-4, AC-STRUCT-5).
 *
 * Everything runs for real - the websocket server, `ConnectionHandler`, the tool loop, the tool
 * dispatcher (web_search / curl with `fetch` doubled), the compact_context interception and
 * `shared/context-usage.ts` - except the provider stream, which hands back generated responses.
 * Assertions are on what the provider was handed and on what the client receives, never on call
 * counts alone. fast-check prints the seed and counterexample path on failure; the seed is fixed
 * for CI determinism and can be overridden with FC_SEED to explore.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import fc from "fast-check";

vi.mock("../../server/ollama-client.js", () => ({
  streamOllamaResponse: vi.fn(),
  buildOllamaChatBody: vi.fn(),
}));

import { ConnectionHandler, loadExecutionLimits } from "../../server/ws-handler.js";
import { streamOllamaResponse } from "../../server/ollama-client.js";
import { CompactContextExecutor } from "../../server/tools/compact-context.js";
import { CurlExecutor } from "../../server/tools/curl.js";
import { WebSearchExecutor } from "../../server/tools/web-search.js";
import type { ConversationStep, ToolDefinition } from "../../server/types.js";
import { buildContextUsageNote, CONTEXT_PLACEMENT } from "../../shared/context-usage.js";
import { normalizeResponseSteps } from "../../shared/normalize-response-steps.js";

const mockStream = vi.mocked(streamOllamaResponse);
const SEED = Number(process.env.FC_SEED ?? 20261002);
const RUNS = 100;
const MODEL = "qwen3:latest";
const NOTE_LEAD = "Automatic note from the app";

let httpServer: Server;
let wss: WebSocketServer;
let port = 0;

beforeAll(async () => {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    new ConnectionHandler(ws, undefined, loadExecutionLimits({}));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  mockStream.mockReset();
  vi.restoreAllMocks();
  process.env.BRAVE_API_KEY = "test-brave-key";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // A fresh Response per call: a body can be read once, and a loop may search repeatedly.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ web: { results: [{ title: "T", url: "https://example.com", description: "D" }] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
});

// -- harness -----------------------------------------------------------------------------------

interface Msg {
  type?: string;
  steps?: ConversationStep[];
  message?: string;
  compaction?: { toolCallStepId?: string; summary?: string; remainingWork?: string };
  [key: string]: unknown;
}

const COMPACT_TOOL: ToolDefinition = new CompactContextExecutor().getToolDefinitions()[0];
const SEARCH_TOOL: ToolDefinition = new WebSearchExecutor().getToolDefinitions()[0];
const CURL_TOOL: ToolDefinition = new CurlExecutor().getToolDefinitions()[0];

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collectUntilTerminal(ws: WebSocket): Promise<Msg[]> {
  return new Promise((resolve, reject) => {
    const msgs: Msg[] = [];
    const timer = setTimeout(() => reject(new Error(`timeout after: ${msgs.map((m) => m.type).join(",")}`)), 5000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Msg;
      msgs.push(msg);
      if (msg.type === "chat.done" || msg.type === "chat.error") {
        clearTimeout(timer);
        resolve(msgs);
      }
    });
  });
}

/**
 * One chat.send against the real server; `responses[i]` answers invocation i and, once they run
 * out, the provider answers with a plain call-free message. Returns the steps each invocation was
 * handed (snapshotted, so a later mutation by the server cannot hide in the record).
 */
async function runLoop(
  request: Record<string, unknown>,
  responses: ConversationStep[][]
): Promise<{ invocations: ConversationStep[][]; messages: Msg[]; terminal: Msg }> {
  const invocations: ConversationStep[][] = [];
  mockStream.mockImplementation(async (args) => {
    invocations.push(structuredClone(args.steps));
    const response = responses[invocations.length - 1] ?? [
      { id: `exhausted-${invocations.length}`, kind: "assistant", title: "assistant", content: "answer", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    args.onDelta(structuredClone(response));
    return structuredClone(response);
  });
  const ws = await connect();
  try {
    const done = collectUntilTerminal(ws);
    ws.send(JSON.stringify({ type: "chat.send", conversationId: `c-${Math.random()}`, model: MODEL, ...request }));
    const messages = await done;
    return { invocations, messages, terminal: messages.at(-1)! };
  } finally {
    ws.close();
  }
}

function makeStep(id: string, kind: ConversationStep["kind"], content: string, extra: Partial<ConversationStep> = {}): ConversationStep {
  return { id, kind, title: kind, content, createdAt: "2026-01-01T00:00:00.000Z", ...extra };
}

const tokens = fc.nat(2_000_000);
const usageArb = fc.option(fc.record({ inputTokens: tokens, outputTokens: tokens }), { nil: undefined });
const word = fc.stringMatching(/^[a-z0-9]{1,10}$/);

/** `modelFamily`: absent, every family the placement data names (default-only today), the families the research probed, or arbitrary text. */
const FAMILIES = [...new Set([...Object.keys(CONTEXT_PLACEMENT.exceptions), "qwen3", "qwen2", "llama", "gemma3", "qwen35"])];
const familyArb = fc.oneof(fc.constant(undefined), fc.constantFrom(...FAMILIES), fc.stringMatching(/^[A-Za-z0-9.:-]{1,12}$/));

const windowArb = fc.option(
  fc.record({
    contextWindow: fc.integer({ min: 1, max: 1_000_000 }),
    contextWindowSource: fc.constantFrom("runtime", "modelfile", "estimated", "assumed"),
  }),
  { nil: undefined }
);

/** Decorates a response with optional usage on one of its steps and optional reasoning prose. */
interface ResponseExtras {
  usage: { inputTokens: number; outputTokens: number } | undefined;
  usageAt: number;
  reasoning: boolean;
}
const extrasArb: fc.Arbitrary<ResponseExtras> = fc.record({ usage: usageArb, usageAt: fc.nat(3), reasoning: fc.boolean() });

function decorate(core: ConversationStep[], extras: ResponseExtras, id: string): ConversationStep[] {
  const steps = extras.reasoning ? [makeStep(`${id}-r`, "reasoning", "thinking"), ...core] : [...core];
  if (extras.usage) {
    // Like retainResponseUsage, usage goes on the prose (assistant) step when the response has one.
    const assistantAt = steps.findIndex((step) => step.kind === "assistant");
    const at = assistantAt >= 0 ? assistantAt : extras.usageAt % steps.length;
    steps[at] = { ...steps[at], usage: extras.usage };
  }
  return steps;
}

// -- AC-STRUCT-4 -------------------------------------------------------------------------------

interface Ac4Spec {
  rounds: Array<{ calls: Array<"search" | "invalidCompact">; extras: ResponseExtras; prose: boolean }>;
  final: ResponseExtras;
  compactEnabled: boolean;
  family: string | undefined;
  window: { contextWindow: number; contextWindowSource: string } | undefined;
  history: { q1: string; a1: string; a1Usage: ResponseExtras["usage"]; q2: string };
}

/** Invocation count 1-6 (0-5 tool rounds plus the answer), rounds interleaving search calls and rejected compact_context calls. */
const ac4Arb: fc.Arbitrary<Ac4Spec> = fc.record({
  rounds: fc.array(
    fc.record({
      calls: fc.array(fc.constantFrom<"search" | "invalidCompact">("search", "search", "invalidCompact"), { minLength: 1, maxLength: 2 }),
      extras: extrasArb,
      prose: fc.boolean(),
    }),
    { maxLength: 5 }
  ),
  final: extrasArb,
  compactEnabled: fc.boolean(),
  family: familyArb,
  window: windowArb,
  history: fc.record({ q1: word, a1: word, a1Usage: usageArb, q2: word }),
});

function materializeAc4(spec: Ac4Spec) {
  let n = 0;
  const nextId = (prefix: string) => `${prefix}-${n++}`;
  const incoming = [
    makeStep("sys", "system", "be terse"),
    makeStep("q1", "user", spec.history.q1),
    makeStep("a1", "assistant", spec.history.a1, spec.history.a1Usage ? { usage: spec.history.a1Usage } : {}),
    makeStep("q2", "user", spec.history.q2),
  ];
  const responses: ConversationStep[][] = spec.rounds.map((round) => {
    const core: ConversationStep[] = [];
    if (round.prose) core.push(makeStep(nextId("prose"), "assistant", "let me look"));
    for (const call of round.calls) {
      const id = nextId("call");
      // A compact_context call is only a rejected-call round while the tool is enabled; disabled, it would end the request in an error.
      const toolCall = call === "search" || !spec.compactEnabled
        ? { id, name: "web_search", arguments: { query: "q" } }
        : { id, name: "compact_context", arguments: { summary: "" } };
      core.push(makeStep(id, "tool_call", `Requested ${toolCall.name}`, { toolCall }));
    }
    return decorate(core, round.extras, nextId("round"));
  });
  responses.push(decorate([makeStep(nextId("final"), "assistant", "all done")], spec.final, nextId("final")));
  return { incoming, responses };
}

/**
 * `inputTokens + outputTokens` of the latest response's usage, written out independently of the
 * module under test: the last step reporting usage, unless an assistant step without usage comes
 * after it (the latest response reported none).
 */
function usedAfter(steps: ConversationStep[]): number | undefined {
  const lastWithUsage = steps.map((s) => !!s.usage).lastIndexOf(true);
  const lastAssistant = steps.map((s) => s.kind === "assistant").lastIndexOf(true);
  if (lastWithUsage < 0 || lastAssistant > lastWithUsage) return undefined;
  const usage = steps[lastWithUsage].usage!;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

describe("AC-STRUCT-4: note from the previous invocation, and no placement leakage", () => {
  it("generators reach every stated range (invocations 1-6, all families and absent, both enablements)", () => {
    const samples = fc.sample(ac4Arb, { numRuns: 400, seed: SEED });
    expect(new Set(samples.map((s) => s.rounds.length + 1))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(new Set(samples.map((s) => s.compactEnabled))).toEqual(new Set([true, false]));
    const families = new Set(samples.map((s) => s.family));
    expect(families.has(undefined)).toBe(true);
    for (const family of FAMILIES) expect(families.has(family)).toBe(true);
    expect(samples.some((s) => s.window === undefined)).toBe(true);
    expect(new Set(samples.map((s) => s.window?.contextWindowSource).filter(Boolean)).size).toBe(4);
    expect(samples.some((s) => s.rounds.some((r) => r.calls.includes("invalidCompact")))).toBe(true);
  });

  it("holds for every generated tool-loop run", async () => {
    await fc.assert(
      fc.asyncProperty(ac4Arb, async (spec) => {
        const { incoming, responses } = materializeAc4(spec);
        const tools = spec.compactEnabled ? [COMPACT_TOOL, SEARCH_TOOL] : [SEARCH_TOOL];
        const { invocations, messages, terminal } = await runLoop(
          { steps: incoming, tools, maxModelInvocations: 10, maxToolCalls: 100, modelFamily: spec.family, ...spec.window },
          responses
        );
        expect(terminal.type).toBe("chat.done");
        expect(invocations).toHaveLength(responses.length);

        const done = terminal;
        const emitted = messages.filter((m) => ["chat.delta", "chat.steps", "chat.done"].includes(m.type ?? "")).flatMap((m) => m.steps ?? []);

        // No emitted step carries the note or is the synthetic note step.
        for (const emittedStep of emitted) {
          expect(JSON.stringify(emittedStep)).not.toContain(NOTE_LEAD);
          expect(emittedStep.id).not.toBe("context-usage-note");
        }

        // The accumulated steps hold the untransformed provider responses: chat.done's non-result steps are exactly their concatenation.
        const expectedResponses = responses.flat().map((s) => ({ ...s, model: MODEL }));
        expect((done.steps ?? []).filter((s) => s.kind !== "tool_result")).toEqual(expectedResponses);

        // Each invocation was handed the accumulated steps so far, plus (only when enabled) exactly one note built from the previous invocation's usage.
        const accumulated = [...normalizeResponseSteps(incoming), ...(done.steps ?? [])];
        let prefixLength = incoming.length;
        for (let k = 0; k < invocations.length; k++) {
          const received = invocations[k];
          const clean = JSON.parse(JSON.stringify(accumulated.slice(0, prefixLength))) as ConversationStep[];
          if (!spec.compactEnabled) {
            expect(received).toEqual(clean);
          } else {
            const usedTokens = k === 0 ? usedAfter(incoming) : usedAfter(responses[k - 1]);
            const note = buildContextUsageNote({
              usedTokens,
              windowTokens: spec.window?.contextWindow ?? 0,
              source: (spec.window?.contextWindowSource ?? "assumed") as "runtime" | "modelfile" | "estimated" | "assumed",
            });
            const carriers = received.filter((s) => s.content.includes(NOTE_LEAD));
            expect(carriers).toHaveLength(1);
            const at = received.indexOf(carriers[0]);
            // The note is the last wire paragraph: appended to a trailing user message, else a user message of its own.
            let stripped: ConversationStep[];
            if (carriers[0].id === "context-usage-note") {
              expect(carriers[0]).toMatchObject({ kind: "user", content: note });
              stripped = received.filter((_, i) => i !== at);
            } else {
              expect(carriers[0].kind).toBe("user");
              expect(carriers[0].content.endsWith(`\n\n${note}`)).toBe(true);
              stripped = received.map((s, i) => (i === at ? { ...s, content: s.content.slice(0, -(note.length + 2)) } : s));
            }
            expect(stripped).toEqual(clean);
          }
          if (k < spec.rounds.length) prefixLength += responses[k].length + spec.rounds[k].calls.length;
        }
      }),
      { numRuns: RUNS, seed: SEED }
    );
  });
});

// -- AC-STRUCT-5 -------------------------------------------------------------------------------

type CallKind = "validCompact" | "invalidCompact" | "web_search" | "curl";
const callKindArb = fc.constantFrom<CallKind>("validCompact", "invalidCompact", "web_search", "curl");

interface Ac5Spec {
  responses: CallKind[][];
  maxModelInvocations: number;
  maxToolCalls: number;
  remainingWork: boolean;
}

const ac5Arb: fc.Arbitrary<Ac5Spec> = fc.record({
  responses: fc.array(fc.array(callKindArb, { maxLength: 3 }), { minLength: 1, maxLength: 7 }),
  maxModelInvocations: fc.integer({ min: 1, max: 6 }),
  maxToolCalls: fc.integer({ min: 1, max: 6 }),
  remainingWork: fc.boolean(),
});

const INVALID_COMPACT_ARGS: Array<Record<string, unknown>> = [{}, { summary: "   " }, { summary: "s", surplus: 1 }];

function materializeAc5(spec: Ac5Spec) {
  let n = 0;
  return spec.responses.map((calls, r) =>
    calls.map((kind) => {
      const id = `call-${n++}`;
      const toolCall =
        kind === "validCompact"
          ? { id, name: "compact_context", arguments: { summary: `summary ${id}`, ...(spec.remainingWork ? { remaining_work: "more" } : {}) } }
          : kind === "invalidCompact"
            ? { id, name: "compact_context", arguments: INVALID_COMPACT_ARGS[r % INVALID_COMPACT_ARGS.length] }
            : kind === "web_search"
              ? { id, name: "web_search", arguments: { query: `q${id}` } }
              : { id, name: "curl", arguments: { url: "https://example.com/" } };
      return makeStep(id, "tool_call", `Requested ${toolCall.name}`, { toolCall });
    })
  );
}

/**
 * The AC-STRUCT-5 oracle, written from the acceptance criterion and the AC-TOOL-5 amendment: the
 * invocation budget is checked before each invocation, the tool-call budget against the response's
 * full call count before anything is intercepted or executed, and every call of a processed
 * response (executed or rejected) is counted.
 */
function simulate(responses: CallKind[][], maxModelInvocations: number, maxToolCalls: number) {
  let toolCallCount = 0;
  let invocations = 0;
  const processed: number[] = [];
  for (let i = 0; ; i++) {
    if (invocations >= maxModelInvocations) return { terminal: "error" as const, budget: "model invocations", invocations, processed, compaction: false };
    invocations++;
    const calls = responses[i] ?? [];
    if (toolCallCount + calls.length > maxToolCalls) return { terminal: "error" as const, budget: "tool calls", invocations, processed, compaction: false };
    processed.push(i);
    toolCallCount += calls.length;
    if (calls.some((c) => c === "validCompact" || c === "invalidCompact")) {
      if (calls.length === 1 && calls[0] === "validCompact") return { terminal: "done" as const, invocations, processed, compaction: true };
      continue;
    }
    if (calls.length === 0) return { terminal: "done" as const, invocations, processed, compaction: false };
  }
}

describe("AC-STRUCT-5: budget accounting is monotone and compaction needs a valid sole call", () => {
  it("generators reach the stated ranges (0-3 calls of every kind, budgets 1-6)", () => {
    const samples = fc.sample(ac5Arb, { numRuns: 400, seed: SEED });
    const responses = samples.flatMap((s) => s.responses);
    expect(new Set(responses.map((r) => r.length))).toEqual(new Set([0, 1, 2, 3]));
    expect(new Set(responses.flat())).toEqual(new Set(["validCompact", "invalidCompact", "web_search", "curl"]));
    expect(new Set(samples.map((s) => s.maxModelInvocations))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(new Set(samples.map((s) => s.maxToolCalls))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    const outcomes = samples.map((s) => simulate(s.responses, s.maxModelInvocations, s.maxToolCalls));
    expect(outcomes.some((o) => o.compaction)).toBe(true);
    expect(outcomes.some((o) => o.terminal === "error" && o.budget === "tool calls")).toBe(true);
    expect(outcomes.some((o) => o.terminal === "error" && o.budget === "model invocations")).toBe(true);
  });

  it("holds for every generated response sequence", async () => {
    await fc.assert(
      fc.asyncProperty(ac5Arb, async (spec) => {
        const responses = materializeAc5(spec);
        const { invocations, messages, terminal } = await runLoop(
          {
            steps: [makeStep("sys", "system", "s"), makeStep("q", "user", "hello")],
            tools: [COMPACT_TOOL, SEARCH_TOOL, CURL_TOOL],
            maxModelInvocations: spec.maxModelInvocations,
            maxToolCalls: spec.maxToolCalls,
          },
          responses
        );
        const expected = simulate(spec.responses, spec.maxModelInvocations, spec.maxToolCalls);

        // Invocations never exceed the budget, and equal the number the accounting allows.
        expect(invocations.length).toBeLessThanOrEqual(spec.maxModelInvocations);
        expect(invocations).toHaveLength(expected.invocations);

        // The request ends exactly where the budgets say, with the matching terminal message.
        expect(terminal.type).toBe(expected.terminal === "done" ? "chat.done" : "chat.error");
        if (expected.terminal === "error") {
          expect(terminal.message).toContain("Execution budget exceeded");
          expect(terminal.message).toContain(expected.budget);
        }

        // compaction appears only when the final response's sole call was a valid compact_context.
        const finalCalls = spec.responses[expected.invocations - 1] ?? [];
        if (terminal.compaction !== undefined) {
          expect(terminal.type).toBe("chat.done");
          expect(finalCalls).toEqual(["validCompact"]);
          expect(terminal.compaction.toolCallStepId).toBe(responses[expected.invocations - 1][0].id);
          expect(terminal.compaction.summary).toBe(String(responses[expected.invocations - 1][0].toolCall!.arguments.summary));
        }
        expect(terminal.compaction !== undefined).toBe(expected.compaction);
        expect(messages.filter((m) => m.type === "chat.done" && m.compaction !== undefined)).toHaveLength(expected.compaction ? 1 : 0);

        // Every call of every processed response got exactly one result (executed or rejected) except the
        // honoured compaction call, which nothing answers; the over-budget response got none.
        const emittedResultIds = new Set(
          messages.flatMap((m) => m.steps ?? []).filter((s) => s.kind === "tool_result").map((s) => s.toolResult!.id)
        );
        const expectedResultIds = new Set(expected.processed.flatMap((i) => (responses[i] ?? []).map((s) => s.id)));
        if (expected.compaction) {
          // The final valid compact_context call receives NO tool_result, in any message of the request.
          const finalCall = responses[expected.invocations - 1][0];
          expect(emittedResultIds.has(finalCall.id)).toBe(false);
          expect(emittedResultIds.has(finalCall.toolCall!.id ?? "")).toBe(false);
          expectedResultIds.delete(finalCall.id);
        }
        expect(emittedResultIds).toEqual(expectedResultIds);
      }),
      { numRuns: RUNS, seed: SEED }
    );
  });
});
