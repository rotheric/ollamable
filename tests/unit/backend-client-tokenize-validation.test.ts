/**
 * Narrowing-guard tests for `asTokenizeResponse` and the tokenize message router
 * (S3-R3 and friends). Covers mutation-gate residuals around off-the-wire
 * malformed inputs that the existing suites hit only via well-formed shapes:
 *
 *   - `typeof msg.requestId !== "string"` return-null guard (line 38).
 *   - `||` composition on tokens / tokenIds Array.isArray checks (line 40).
 *   - `msg.type === "tokenize.error"` branch guard (line 43).
 *   - `pendingTokenize.delete(requestId)` after a resolved result (line 134).
 *
 * The oracle is behavioural: a malformed tokenize-shaped message must leave
 * the caller's promise pending (so a subsequent well-formed response for the
 * same requestId still settles it), and a non-tokenize type must not resolve
 * a tokenize call. Property-based testing is overkill for a 3-key schema;
 * this is table-driven across the discrete malformed shapes.
 */
import { describe, it, expect, vi } from "vitest";
import { BackendClient } from "@/src/lib/backend-client";

function pending() {
  const client = new BackendClient();
  const sent: Array<{ requestId: string }> = [];
  const send = vi.fn((data: unknown) => {
    sent.push(data as { requestId: string });
    return true;
  });
  const promise = client.tokenize(send, "qwen3:1.7b", "hi");
  // Suppress unhandled-rejection on cases we don't settle.
  promise.catch(() => {});
  return { client, promise, send, requestId: () => sent[0].requestId };
}

describe("asTokenizeResponse narrowing: malformed off-the-wire tokenize messages do not settle the caller", () => {
  it.each<[string, (requestId: string) => Record<string, unknown>]>([
    ["result shape with a non-string requestId",
      () => ({ type: "tokenize.result", requestId: 42, tokens: ["hi"], tokenIds: [1] })],
    ["result shape with no requestId at all",
      () => ({ type: "tokenize.result", tokens: ["hi"], tokenIds: [1] })],
    ["result shape with tokens non-array (tokenIds array)",
      (rid) => ({ type: "tokenize.result", requestId: rid, tokens: "oops", tokenIds: [1] })],
    ["result shape with tokenIds non-array (tokens array)",
      (rid) => ({ type: "tokenize.result", requestId: rid, tokens: ["hi"], tokenIds: "oops" })],
    ["result shape with both non-array",
      (rid) => ({ type: "tokenize.result", requestId: rid, tokens: "o", tokenIds: "p" })],
    ["error shape with no reason",
      (rid) => ({ type: "tokenize.error", requestId: rid })],
    ["error shape with a non-string reason",
      (rid) => ({ type: "tokenize.error", requestId: rid, reason: 99 })],
    ["an unrelated type carrying a tokenize-shaped requestId",
      (rid) => ({ type: "pong", requestId: rid, tokens: ["hi"], tokenIds: [1], reason: "x" })],
  ])("%s is dropped and leaves the pending caller pending", async (_label, build) => {
    const call = pending();
    const malformed = build(call.requestId());

    expect(() => call.client.handleServerMessage(malformed)).not.toThrow();

    // The caller's promise is still pending: a well-formed answer still settles it.
    call.client.handleServerMessage({
      type: "tokenize.result",
      requestId: call.requestId(),
      tokens: ["hi"],
      tokenIds: [1],
    });
    await expect(call.promise).resolves.toEqual({ tokens: ["hi"], tokenIds: [1] });
  });

  it("non-tokenize messages without a requestId never resolve any pending tokenize call", async () => {
    const call = pending();
    // These are the regular `ServerMessage` shapes the chat routing handles.
    const shapes: Array<Record<string, unknown>> = [
      { type: "chat.delta", conversationId: "x", steps: [] },
      { type: "chat.done", conversationId: "x", steps: [] },
      { type: "meta.event", conversationId: "x", event: { id: "1", kind: "init", title: "t", detail: "d", timestamp: "2026-01-01T00:00:00Z" } },
      { type: "protocol.error", message: "x" },
    ];
    for (const m of shapes) expect(() => call.client.handleServerMessage(m)).not.toThrow();

    // Still pending — the tokenize map was not touched.
    call.client.handleServerMessage({ type: "tokenize.result", requestId: call.requestId(), tokens: ["hi"], tokenIds: [1] });
    await expect(call.promise).resolves.toEqual({ tokens: ["hi"], tokenIds: [1] });
  });
});

describe("pendingTokenize bookkeeping across settlement paths", () => {
  it("a duplicate tokenize.result for the same requestId is silently ignored after the first settles", async () => {
    const call = pending();

    call.client.handleServerMessage({ type: "tokenize.result", requestId: call.requestId(), tokens: ["a"], tokenIds: [1] });
    await expect(call.promise).resolves.toEqual({ tokens: ["a"], tokenIds: [1] });

    // Second answer for the same requestId must not reject (the first already resolved) and must not throw.
    expect(() =>
      call.client.handleServerMessage({ type: "tokenize.result", requestId: call.requestId(), tokens: ["b"], tokenIds: [2] })
    ).not.toThrow();
    expect(() =>
      call.client.handleServerMessage({ type: "tokenize.error", requestId: call.requestId(), reason: "late" })
    ).not.toThrow();
  });

  it("a tokenize.result/error cross-fire for the same requestId settles with the first answer only", async () => {
    const resultFirst = pending();
    resultFirst.client.handleServerMessage({ type: "tokenize.result", requestId: resultFirst.requestId(), tokens: ["x"], tokenIds: [1] });
    expect(() =>
      resultFirst.client.handleServerMessage({ type: "tokenize.error", requestId: resultFirst.requestId(), reason: "late" })
    ).not.toThrow();
    await expect(resultFirst.promise).resolves.toEqual({ tokens: ["x"], tokenIds: [1] });

    const errorFirst = pending();
    errorFirst.client.handleServerMessage({ type: "tokenize.error", requestId: errorFirst.requestId(), reason: "nope" });
    expect(() =>
      errorFirst.client.handleServerMessage({ type: "tokenize.result", requestId: errorFirst.requestId(), tokens: ["y"], tokenIds: [2] })
    ).not.toThrow();
    await expect(errorFirst.promise).rejects.toThrow("nope");
  });
});
