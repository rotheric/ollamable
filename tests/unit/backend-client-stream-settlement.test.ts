/**
 * Once a chat stream has settled — by a server error, a failed send or a lost
 * connection — its `stop()` must be inert: no `chat.stop` goes over the wire
 * for a request the server no longer runs. Also pins that only `meta.event`
 * messages become meta steps.
 */
import { describe, it, expect, vi } from "vitest";
import { BackendClient } from "@/src/lib/backend-client";

function request() {
  return { conversationId: "conv", model: "m", steps: [], tools: [],
    onDelta: vi.fn(), onStableSteps: vi.fn(), onMetaEvent: vi.fn() };
}

const stopsSent = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.filter(([m]) => (m as { type: string }).type === "chat.stop");

describe("stop after the stream settled", () => {
  it("sends no chat.stop after the server reported an error", async () => {
    const client = new BackendClient();
    const send = vi.fn((_m: unknown) => true);
    const stream = client.startStream(send, request());
    const requestId = (send.mock.calls[0][0] as { requestId: string }).requestId;
    client.handleServerMessage({ type: "chat.error", conversationId: "conv", requestId, message: "boom" });
    await expect(stream.promise).rejects.toThrow("boom");
    stream.stop();
    expect(stopsSent(send)).toEqual([]);
  });

  it("rejects with a generic message when the server error carries none", async () => {
    const client = new BackendClient();
    const send = vi.fn((_m: unknown) => true);
    const stream = client.startStream(send, request());
    const requestId = (send.mock.calls[0][0] as { requestId: string }).requestId;
    client.handleServerMessage({ type: "chat.error", conversationId: "conv", requestId });
    await expect(stream.promise).rejects.toThrow("Server error");
  });

  it.each([
    ["returns false", () => false],
    ["throws", () => { throw new Error("broken"); }],
  ])("sends no chat.stop after the initial send %s", async (_label, fail) => {
    const client = new BackendClient();
    let first = true;
    const send = vi.fn((_m: unknown) => {
      if (first) { first = false; return fail(); }
      return true;
    });
    const stream = client.startStream(send, request());
    await expect(stream.promise).rejects.toThrow();
    stream.stop();
    expect(stopsSent(send)).toEqual([]);
  });

  it("sends no chat.stop after the connection was lost", async () => {
    const client = new BackendClient();
    const send = vi.fn((_m: unknown) => true);
    const stream = client.startStream(send, request());
    client.connectionClosed();
    await expect(stream.promise).rejects.toMatchObject({ name: "ConnectionLostError" });
    stream.stop();
    expect(stopsSent(send)).toEqual([]);
  });

  it("still sends chat.stop for a stream that is running", async () => {
    const client = new BackendClient();
    const send = vi.fn((_m: unknown) => true);
    const stream = client.startStream(send, request());
    stream.stop();
    await expect(stream.promise).rejects.toThrow("AbortError");
    expect(stopsSent(send)).toHaveLength(1);
  });
});

describe("meta steps", () => {
  it("does not turn an event field on a non-meta message into a meta step", () => {
    const client = new BackendClient();
    const send = vi.fn((_m: unknown) => true);
    const callbacks = request();
    client.startStream(send, callbacks);
    const requestId = (send.mock.calls[0][0] as { requestId: string }).requestId;
    const event = { id: "e", kind: "search_start", title: "t", detail: "d", timestamp: "2026-01-01T00:00:00Z" };
    client.handleServerMessage({ type: "chat.steps", conversationId: "conv", requestId, steps: [], event });
    expect(callbacks.onStableSteps).toHaveBeenCalledOnce();
    expect(callbacks.onMetaEvent).not.toHaveBeenCalled();
    client.handleServerMessage({ type: "meta.event", conversationId: "conv", requestId, event });
    expect(callbacks.onMetaEvent).toHaveBeenCalledOnce();
  });
});
