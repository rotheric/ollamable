import { describe, expect, it, vi } from "vitest";
import { BackendClient } from "@/src/lib/backend-client";

function request() {
  return { conversationId: "conversation", model: "model", steps: [], tools: [],
    onDelta: vi.fn(), onStableSteps: vi.fn(), onMetaEvent: vi.fn() };
}

describe("chat transport lifecycle", () => {
  it.each(["false", "throw"])("rejects and removes pending chat when send returns %s", async (mode) => {
    const client = new BackendClient();
    const callbacks = request();
    const send = () => { if (mode === "throw") throw new Error("broken transport"); return false; };
    const stream = client.startStream(send, callbacks);
    await expect(stream.promise).rejects.toThrow(mode === "throw" ? "broken transport" : "socket not open");
    client.handleServerMessage({ type: "chat.delta", conversationId: callbacks.conversationId, steps: [] });
    expect(callbacks.onDelta).not.toHaveBeenCalled();
    expect(() => stream.stop()).not.toThrow();
  });

  it("rejects chat distinctly on disconnect, clears tokenization timers, and permits manual retry", async () => {
    const client = new BackendClient();
    const callbacks = request();
    const old = client.startStream(() => true, callbacks);
    const tokenize = client.tokenize(() => true, "model", "text");
    client.connectionClosed();
    await expect(old.promise).rejects.toMatchObject({ name: "ConnectionLostError" });
    await expect(tokenize).rejects.toThrow("AbortError");
    client.handleServerMessage({ type: "chat.delta", conversationId: callbacks.conversationId, steps: [] });
    expect(callbacks.onDelta).not.toHaveBeenCalled();
    const send = vi.fn((_message: unknown) => true);
    const retry = client.startStream(send, callbacks);
    client.handleServerMessage({ type: "chat.done", conversationId: callbacks.conversationId,
      requestId: (send.mock.calls[0][0] as { requestId: string }).requestId, steps: [] });
    await expect(retry.promise).resolves.toEqual([]);
  });
  it("ignores old generation messages and stop callbacks after replacement", async () => {
    const client = new BackendClient();
    const send = vi.fn((_message: unknown) => true);
    const older = client.startStream(send, request());
    const oldFailure = expect(older.promise).rejects.toThrow("superseded");
    const callbacks = request();
    const newer = client.startStream(send, callbacks);
    await oldFailure;
    const oldId = (send.mock.calls[0][0] as { requestId: string }).requestId;
    const newId = (send.mock.calls[1][0] as { requestId: string }).requestId;
    expect(oldId).not.toBe(newId);
    older.stop();
    expect(send).toHaveBeenCalledTimes(2);
    for (const type of ["chat.delta", "chat.steps", "chat.done", "chat.error", "meta.event"]) {
      client.handleServerMessage({ type, requestId: oldId, conversationId: "conversation", steps: [], message: "late error" });
    }
    expect(callbacks.onDelta).not.toHaveBeenCalled();
    expect(callbacks.onStableSteps).not.toHaveBeenCalled();
    expect(callbacks.onMetaEvent).not.toHaveBeenCalled();
    client.handleServerMessage({ type: "chat.delta", requestId: newId, conversationId: "conversation", steps: [] });
    expect(callbacks.onDelta).toHaveBeenCalledOnce();
    client.handleServerMessage({ type: "chat.done", requestId: newId, conversationId: "conversation", steps: [] });
    await expect(newer.promise).resolves.toEqual([]);
  });

});
