/**
 * Integration tests for `streamOllamaResponse`'s stream-boundary retention
 * (AC-STRUCT-2, AC-TOK-4) and the delta-accumulation join invariant
 * (architecture.md Order-Sensitive Composition Flow 2).
 *
 * These drive the real exported `streamOllamaResponse` against a mocked
 * `fetch` whose Response.body is a genuine ReadableStream, so the test
 * exercises the same network-chunk buffering, NDJSON line-splitting, and
 * delta-accumulation code Ollama's real HTTP stream drives — not a
 * hand-rolled accumulation stand-in.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { streamOllamaResponse } from "../../server/ollama-client.js";
import type { ConversationStep, ToolDefinition } from "../../server/types.js";

const noTools: ToolDefinition[] = [];

const userStep: ConversationStep = {
  id: "u1",
  kind: "user",
  title: "User",
  content: "Hello",
  createdAt: new Date().toISOString(),
};

/**
 * Builds a mocked `Response` whose body is a ReadableStream emitting the
 * given raw network chunks (already UTF-8 bytes). Each entry in
 * `rawChunks` is delivered as one `controller.enqueue` call, i.e. one
 * `reader.read()` resolution in `streamOllamaResponse` — this lets tests
 * control exactly where a multi-byte UTF-8 sequence or an NDJSON line is
 * split across network reads, independent of where JSON-line boundaries
 * fall.
 */
function makeStreamResponse(rawChunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of rawChunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** Encodes NDJSON lines into a single byte buffer, one JSON object per line. */
function encodeLines(objects: Array<Record<string, unknown>>): Uint8Array {
  const text = objects.map((o) => JSON.stringify(o)).join("\n") + "\n";
  return new TextEncoder().encode(text);
}

/**
 * Splits a byte buffer into `n` roughly-equal pieces at arbitrary byte
 * offsets (not line or character boundaries), simulating how TCP/HTTP
 * chunking can split a network read mid multi-byte UTF-8 sequence or
 * mid JSON-line.
 */
function splitBytes(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  let start = 0;
  for (const offset of offsets) {
    pieces.push(bytes.slice(start, offset));
    start = offset;
  }
  pieces.push(bytes.slice(start));
  return pieces.filter((p) => p.length > 0);
}

async function runStream(rawChunks: Uint8Array[]) {
  const deltaSnapshots: ConversationStep[][] = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(makeStreamResponse(rawChunks));

  const finalSteps = await streamOllamaResponse({
    model: "qwen3:latest",
    steps: [userStep],
    tools: noTools,
    onDelta: (steps) => {
      // Snapshot deep-enough to survive further in-place mutation of the
      // same step objects (processStreamLine mutates assistantStep in place).
      deltaSnapshots.push(steps.map((s) => ({ ...s, contentTokens: s.contentTokens ? [...s.contentTokens] : s.contentTokens })));
    },
  });

  fetchSpy.mockRestore();
  return { finalSteps, deltaSnapshots };
}

// Tracks, across calls within a single scenario, the last-seen
// contentTokens.length per step id — lets us assert the array only ever
// grows (append-only), never shrinks or gets replaced wholesale.
function assertJoinInvariant(steps: ConversationStep[], seenLengths: Map<string, number>) {
  for (const step of steps) {
    if (step.kind !== "assistant" && step.kind !== "reasoning") continue;
    if (step.content.length === 0) continue;

    // A non-empty-content assistant/reasoning step MUST carry
    // contentTokens — this is the invariant a push hoisted out of the
    // accumulation guard (done only at `done`) would violate mid-stream.
    expect(step.contentTokens).toBeDefined();
    expect(step.contentTokens!.join("")).toBe(step.content);

    const previousLength = seenLengths.get(step.id) ?? 0;
    expect(step.contentTokens!.length).toBeGreaterThanOrEqual(previousLength);
    seenLengths.set(step.id, step.contentTokens!.length);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── AC-STRUCT-2: contentTokens shape + join invariant at completion ──────

describe("AC-STRUCT-2: contentTokens retention on completion", () => {
  it("assistant step's contentTokens.length equals the number of non-empty content chunks, join invariant holds", async () => {
    const chunks = [
      { message: { content: "Hello" }, done: false },
      { message: { content: "" }, done: false }, // empty content chunk must NOT be counted
      { message: { content: " there" }, done: false },
      { message: { content: "!" }, done: false },
      { done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 4 },
    ];

    const { finalSteps } = await runStream([encodeLines(chunks)]);

    const assistant = finalSteps.find((s) => s.kind === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.contentTokens).toEqual(["Hello", " there", "!"]);
    expect(assistant!.contentTokens!.join("")).toBe(assistant!.content);
    expect(assistant!.content).toBe("Hello there!");
  });

  it("a co-occurring reasoning step carries its own independent contentTokens array", async () => {
    const chunks = [
      { message: { thinking: "Let me " }, done: false },
      { message: { thinking: "think." }, done: false },
      { message: { content: "Answer" }, done: false },
      { message: { content: "." }, done: false },
      { done: true, done_reason: "stop", eval_count: 6 },
    ];

    const { finalSteps } = await runStream([encodeLines(chunks)]);

    const reasoning = finalSteps.find((s) => s.kind === "reasoning");
    const assistant = finalSteps.find((s) => s.kind === "assistant");
    expect(reasoning).toBeDefined();
    expect(assistant).toBeDefined();

    expect(reasoning!.contentTokens).toEqual(["Let me ", "think."]);
    expect(reasoning!.contentTokens!.join("")).toBe(reasoning!.content);

    expect(assistant!.contentTokens).toEqual(["Answer", "."]);
    expect(assistant!.contentTokens!.join("")).toBe(assistant!.content);

    // Independence: neither array borrows from the other.
    expect(assistant!.contentTokens).not.toEqual(reasoning!.contentTokens);
  });
});

// ── Flow 2: join invariant holds at EVERY observation point, across ──────
// ── multiple distinct chunk orderings, not only at `done`.            ──

describe("Order-Sensitive Composition Flow 2: join invariant across orderings", () => {
  const scenarios: Array<{ name: string; chunks: Array<Record<string, unknown>> }> = [
    {
      name: "content-only, multiple small chunks",
      chunks: [
        { message: { content: "A" }, done: false },
        { message: { content: "B" }, done: false },
        { message: { content: "C" }, done: false },
        { done: true, eval_count: 3 },
      ],
    },
    {
      name: "thinking-then-content (realistic ordering)",
      chunks: [
        { message: { thinking: "Reasoning " }, done: false },
        { message: { thinking: "step one." }, done: false },
        { message: { content: "Final " }, done: false },
        { message: { content: "answer." }, done: false },
        { done: true, eval_count: 4 },
      ],
    },
    {
      name: "content-then-thinking (unusual ordering, robustness)",
      chunks: [
        { message: { content: "Answer " }, done: false },
        { message: { content: "first." }, done: false },
        { message: { thinking: "Reasoning " }, done: false },
        { message: { thinking: "after." }, done: false },
        { done: true, eval_count: 4 },
      ],
    },
    {
      name: "alternating thinking/content",
      chunks: [
        { message: { thinking: "T1 " }, done: false },
        { message: { content: "C1 " }, done: false },
        { message: { thinking: "T2 " }, done: false },
        { message: { content: "C2" }, done: false },
        { done: true, eval_count: 4 },
      ],
    },
  ];

  it.each(scenarios)("$name: invariant holds after every onDelta, not only at done", async ({ chunks }) => {
    const { finalSteps, deltaSnapshots } = await runStream([encodeLines(chunks)]);

    expect(deltaSnapshots.length).toBeGreaterThan(0);
    const seenLengths = new Map<string, number>();
    for (const snapshot of deltaSnapshots) {
      assertJoinInvariant(snapshot, seenLengths);
    }
    assertJoinInvariant(finalSteps, seenLengths);
  });

  it("holds when a multi-byte UTF-8 character is split mid-sequence across network reads", async () => {
    // "café 🚀" — both the accented "é" (2 bytes) and the emoji (4 bytes)
    // are multi-byte UTF-8 sequences. Split the raw byte buffer at an
    // arbitrary offset that lands inside one of those sequences.
    const chunks = [
      { message: { content: "café 🚀" }, done: false },
      { done: true, eval_count: 1 },
    ];
    const fullBytes = encodeLines(chunks);

    // Find the byte offset of the emoji's leading byte and split one byte
    // into its interior, plus one more arbitrary split earlier in the
    // buffer, to exercise multiple partial-decode boundaries in one read.
    const text = new TextDecoder().decode(fullBytes);
    const emojiCharIndex = text.indexOf("\u{1F680}");
    expect(emojiCharIndex).toBeGreaterThan(-1);
    const emojiByteOffset = new TextEncoder().encode(text.slice(0, emojiCharIndex)).length;

    const { finalSteps, deltaSnapshots } = await runStream(
      splitBytes(fullBytes, [10, emojiByteOffset + 2])
    );

    expect(deltaSnapshots.length).toBeGreaterThan(0);
    const seenLengths = new Map<string, number>();
    for (const snapshot of deltaSnapshots) assertJoinInvariant(snapshot, seenLengths);

    const assistant = finalSteps.find((s) => s.kind === "assistant");
    expect(assistant!.content).toBe("café 🚀");
    expect(assistant!.contentTokens!.join("")).toBe("café 🚀");
  });

  it("holds when an NDJSON line itself is split mid-line across network reads", async () => {
    const chunks = [
      { message: { content: "Hello" }, done: false },
      { message: { content: " world" }, done: false },
      { done: true, eval_count: 2 },
    ];
    const fullBytes = encodeLines(chunks);
    const midpoint = Math.floor(fullBytes.length / 2);

    const { finalSteps, deltaSnapshots } = await runStream(splitBytes(fullBytes, [midpoint]));

    expect(deltaSnapshots.length).toBeGreaterThan(0);
    const seenLengths = new Map<string, number>();
    for (const snapshot of deltaSnapshots) assertJoinInvariant(snapshot, seenLengths);

    const assistant = finalSteps.find((s) => s.kind === "assistant");
    expect(assistant!.content).toBe("Hello world");
  });
});

// ── AC-TOK-4: plain-completion contentTokens.length vs eval_count ────────
//
// These replay real Ollama transcripts (Ollama 0.30.8, live host, plain
// completions with no thinking and no tool calls) byte-for-byte through
// the same makeStreamResponse/runStream harness used above — chunk
// boundaries this test file did not itself author. See
// specs/epic-token-view/architecture.md constraint 8b and the ownership
// ledger entry `path-stream-transcript-fixtures`.
//
// eval_count and done_reason are read out of each fixture's recorded
// final NDJSON line, never restated as literals here.

interface FixtureFinalChunk {
  done?: boolean;
  done_reason?: string;
  eval_count?: number;
}

interface FixtureContentChunk {
  message?: { content?: string };
  done?: boolean;
}

function loadNdjsonFixture(relativePath: string): {
  bytes: Uint8Array;
  finalLine: FixtureFinalChunk;
  expectedContent: string;
} {
  const absolutePath = fileURLToPath(new URL(relativePath, import.meta.url));
  const bytes = readFileSync(absolutePath);
  const text = new TextDecoder().decode(bytes);
  const parsedLines = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as FixtureContentChunk & FixtureFinalChunk);

  const finalLine = parsedLines[parsedLines.length - 1];
  const expectedContent = parsedLines
    .filter((c) => !c.done)
    .map((c) => c.message?.content ?? "")
    .join("");

  return { bytes, finalLine, expectedContent };
}

/**
 * AC-TOK-4's N/N-1 relationship, applied generically: when the stream
 * ended on an EOS token (done_reason "stop"), that trailing token is
 * counted in eval_count but produced no content chunk of its own, so
 * contentTokens.length is eval_count - 1. Any other done_reason (e.g.
 * "length") means the last generated token WAS a content token, so
 * contentTokens.length equals eval_count exactly.
 */
function expectedContentTokenCount(finalLine: FixtureFinalChunk): number {
  const evalCount = finalLine.eval_count!;
  return finalLine.done_reason === "stop" ? evalCount - 1 : evalCount;
}

describe("AC-TOK-4: plain completion contentTokens.length vs eval_count", () => {
  it("N-1 case: recorded transcript ending on an EOS token (done_reason: stop)", async () => {
    const { bytes, finalLine, expectedContent } = loadNdjsonFixture(
      "../fixtures/plain-completion-stream.ndjson"
    );
    expect(finalLine.done_reason).toBe("stop");

    const { finalSteps } = await runStream([bytes]);
    const assistant = finalSteps.find((s) => s.kind === "assistant")!;

    expect(assistant.content).toBe(expectedContent);
    expect(assistant.usage?.outputTokens).toBe(finalLine.eval_count);
    expect(assistant.contentTokens).toHaveLength(expectedContentTokenCount(finalLine));
  });

  it("N case: recorded transcript ending without an EOS token (done_reason: length)", async () => {
    const { bytes, finalLine, expectedContent } = loadNdjsonFixture(
      "../fixtures/plain-completion-stream-length-capped.ndjson"
    );
    expect(finalLine.done_reason).toBe("length");

    const { finalSteps } = await runStream([bytes]);
    const assistant = finalSteps.find((s) => s.kind === "assistant")!;

    // The fixture's text carries a trailing newline and double spaces
    // ("1. one  \n2.") — compared byte-for-byte, never normalized away.
    expect(assistant.content).toBe(expectedContent);
    expect(assistant.usage?.outputTokens).toBe(finalLine.eval_count);
    expect(assistant.contentTokens).toHaveLength(expectedContentTokenCount(finalLine));
  });

  // AC-TOK-4 explicitly MUST NOT be asserted for completions with a
  // reasoning step or tool_calls (eval_count there includes thinking
  // tokens, think-tag specials, and tool-call markup never emitted as
  // content). No test in this file makes that assertion for such a
  // stream; the reasoning-step scenarios above (Flow 2 suite) deliberately
  // omit any contentTokens.length-vs-eval_count comparison.
});
