/**
 * Unit tests for BackendClient.tokenize() (epic-token-view story S3).
 *
 * Covers the seam architecture.md's Implementation Constraint 1 flags:
 * `handleServerMessage` drops any message lacking `conversationId`
 * (line ~60), so `tokenize.result`/`tokenize.error` — which carry no
 * conversationId at all — must be handled ahead of (or independent of)
 * that guard, correlated by `requestId` via their own map.
 */

import { describe, it, expect, vi } from "vitest";
import { BackendClient } from "@/src/lib/backend-client";

describe("BackendClient.tokenize()", () => {
  it("mints a requestId, sends a tokenize message, and resolves on the matching tokenize.result", async () => {
    const client = new BackendClient();
    const sent: unknown[] = [];
    const send = (data: unknown) => { sent.push(data); return true; };

    const promise = client.tokenize(send, "qwen3:1.7b", "Hello world");
    expect(sent).toHaveLength(1);
    const sentMsg = sent[0] as { type: string; requestId: string; model: string; text: string };
    expect(sentMsg.type).toBe("tokenize");
    expect(sentMsg.model).toBe("qwen3:1.7b");
    expect(sentMsg.text).toBe("Hello world");
    expect(typeof sentMsg.requestId).toBe("string");
    expect(sentMsg.requestId.length).toBeGreaterThan(0);

    client.handleServerMessage({
      type: "tokenize.result",
      requestId: sentMsg.requestId,
      tokens: ["Hello", " world"],
      tokenIds: [1, 2],
    });

    await expect(promise).resolves.toEqual({ tokens: ["Hello", " world"], tokenIds: [1, 2] });
  });

  it("rejects on the matching tokenize.error, carrying the reason", async () => {
    const client = new BackendClient();
    const sent: unknown[] = [];
    const send = (data: unknown) => { sent.push(data); return true; };

    const promise = client.tokenize(send, "some-model", "hi");
    const requestId = (sent[0] as { requestId: string }).requestId;

    client.handleServerMessage({ type: "tokenize.error", requestId, reason: "unsupported_provider" });

    await expect(promise).rejects.toThrow("unsupported_provider");
  });

  it("S3-R3: a malformed tokenize.result (missing tokens/tokenIds) is never treated as a valid response", async () => {
    const client = new BackendClient();
    const send = vi.fn((_data: unknown) => true);
    const promise = client.tokenize(send, "qwen3:1.7b", "hi");
    const requestId = (send.mock.calls[0][0] as { requestId: string }).requestId;

    // Missing `tokens`/`tokenIds` entirely — must fail the narrowing guard
    // rather than resolve with holes (`{tokens: undefined, ...}`).
    client.handleServerMessage({ type: "tokenize.result", requestId });

    // The malformed message is dropped, not treated as the answer — the
    // promise is still pending on its own pendingTokenize entry, so a
    // subsequent well-formed message for the same requestId still resolves it.
    client.handleServerMessage({ type: "tokenize.result", requestId, tokens: ["hi"], tokenIds: [7] });
    await expect(promise).resolves.toEqual({ tokens: ["hi"], tokenIds: [7] });
  });

  it("S3-R3: a malformed tokenize.error (missing reason) is never treated as a valid response", async () => {
    const client = new BackendClient();
    const send = vi.fn((_data: unknown) => true);
    const promise = client.tokenize(send, "qwen3:1.7b", "hi");
    const requestId = (send.mock.calls[0][0] as { requestId: string }).requestId;

    // Missing `reason` — must not resolve into `new Error(undefined)`.
    client.handleServerMessage({ type: "tokenize.error", requestId });

    client.handleServerMessage({ type: "tokenize.error", requestId, reason: "vocab_unavailable" });
    await expect(promise).rejects.toThrow("vocab_unavailable");
  });

  it("is NOT dropped by the conversationId guard — tokenize.result carries no conversationId at all", async () => {
    const client = new BackendClient();
    const send = vi.fn((_data: unknown) => true); // an OPEN socket, per src/lib/use-websocket.ts's send() contract
    const promise = client.tokenize(send, "qwen3:1.7b", "hi");
    const requestId = (send.mock.calls[0][0] as { requestId: string }).requestId;

    // No conversationId anywhere in this message — the pre-S3 guard
    // `if (!msg.type || !msg.conversationId) return;` would silently drop
    // this if the tokenize branch sat behind it.
    client.handleServerMessage({ type: "tokenize.result", requestId, tokens: ["hi"], tokenIds: [7] });

    await expect(promise).resolves.toEqual({ tokens: ["hi"], tokenIds: [7] });
  });

  it("correlates by requestId, independent of any concurrent chat stream keyed by conversationId", async () => {
    const client = new BackendClient();
    const send = vi.fn((_data: unknown) => true); // an OPEN socket, per src/lib/use-websocket.ts's send() contract

    // Start a concurrent chat stream on a conversationId — must not
    // interfere with tokenize's own requestId-keyed map.
    const chatPromise = client.startStream(send, {
      conversationId: "conv-1",
      model: "qwen3:1.7b",
      steps: [],
      tools: [],
      onDelta: () => {},
      onStableSteps: () => {},
      onMetaEvent: () => {},
    }).promise;

    const tokenizePromise = client.tokenize(send, "qwen3:1.7b", "hi");
    const requestId = (send.mock.calls.find((c) => (c[0] as { type: string }).type === "tokenize")![0] as {
      requestId: string;
    }).requestId;

    client.handleServerMessage({ type: "tokenize.result", requestId, tokens: ["hi"], tokenIds: [3] });
    await expect(tokenizePromise).resolves.toEqual({ tokens: ["hi"], tokenIds: [3] });

    client.handleServerMessage({ type: "chat.done", conversationId: "conv-1", steps: [] });
    await expect(chatPromise).resolves.toEqual([]);
  });

  it("ignores a tokenize.result/error whose requestId has no pending caller (already resolved or unknown)", () => {
    const client = new BackendClient();
    expect(() =>
      client.handleServerMessage({ type: "tokenize.result", requestId: "unknown", tokens: [], tokenIds: [] })
    ).not.toThrow();
  });

  it("cancelAll() rejects any in-flight tokenize calls", async () => {
    const client = new BackendClient();
    const send = vi.fn((_data: unknown) => true); // an OPEN socket, per src/lib/use-websocket.ts's send() contract
    const promise = client.tokenize(send, "qwen3:1.7b", "hi");
    client.cancelAll();
    await expect(promise).rejects.toThrow("AbortError");
  });

  // ── S3-F2: leaked pendingTokenize entries ────────────────────────────

  it("rejects immediately when send() reports the socket is not open, instead of registering a promise that never settles", async () => {
    const client = new BackendClient();
    const send = vi.fn((_data: unknown) => false); // mirrors use-websocket's send() when the socket isn't OPEN
    const promise = client.tokenize(send, "qwen3:1.7b", "hi");
    await expect(promise).rejects.toThrow("socket not open");
  });

  it("times out and rejects if no tokenize.result/error ever arrives, instead of leaking the pendingTokenize entry forever", async () => {
    vi.useFakeTimers();
    try {
      const client = new BackendClient();
      const send = vi.fn((_data: unknown) => true);
      const promise = client.tokenize(send, "qwen3:1.7b", "hi");
      // Attach the rejection assertion BEFORE advancing fake time, so a
      // handler exists on `promise` before the timer callback rejects it
      // — otherwise the timer firing during advanceTimersByTimeAsync can
      // reject before this line ever runs, surfacing as an unhandled
      // rejection instead of a passing assertion.
      const rejection = expect(promise).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;

      // A late, otherwise-matching response after the timeout must not
      // throw (the entry was already deleted) and must not resolve
      // anything — there is nothing left listening for it.
      const requestId = (send.mock.calls[0][0] as { requestId: string }).requestId;
      expect(() =>
        client.handleServerMessage({ type: "tokenize.result", requestId, tokens: ["hi"], tokenIds: [1] })
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── S3-F4: explicit provider threading ───────────────────────────────

  it("includes the explicit provider field in the outgoing tokenize message when supplied", () => {
    const client = new BackendClient();
    const sent: unknown[] = [];
    const send = (data: unknown) => {
      sent.push(data);
      return true;
    };

    void client.tokenize(send, "shared-model", "hi", "secondary");

    const sentMsg = sent[0] as { provider?: string };
    expect(sentMsg.provider).toBe("secondary");
  });

  it("omits the provider field when the caller supplies none (backward compatible with pre-S3-F4 callers)", () => {
    const client = new BackendClient();
    const sent: unknown[] = [];
    const send = (data: unknown) => {
      sent.push(data);
      return true;
    };

    void client.tokenize(send, "shared-model", "hi");

    const sentMsg = sent[0] as { provider?: string };
    expect(sentMsg.provider).toBeUndefined();
  });
});
