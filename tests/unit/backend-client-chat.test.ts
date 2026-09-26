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
    const retry = client.startStream(() => true, callbacks);
    client.handleServerMessage({ type: "chat.done", conversationId: callbacks.conversationId, steps: [] });
    await expect(retry.promise).resolves.toEqual([]);
  });
});
