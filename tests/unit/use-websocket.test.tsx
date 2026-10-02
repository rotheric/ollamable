/**
 * Tests for the real useWebSocket hook. Every component test mocks this
 * module, so nothing else executes it: connection state, the reconnect
 * loop, keep-alive pings and the unmount teardown are only covered here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWebSocket } from "@/src/lib/use-websocket";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  /** What the hook calls; a real socket fires `onclose` when it closes. */
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  // ── Test drivers: what the server/network does to the socket ──
  serverOpens() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverSends(raw: string) {
    this.onmessage?.({ data: raw });
  }

  connectionDrops() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onerror?.();
    this.onclose?.();
  }
}

function latestSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useWebSocket", () => {
  it("connects to the given URL and reports connected only once the socket opens", () => {
    const { result } = renderHook(() => useWebSocket("ws://backend.test:3001"));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(latestSocket().url).toBe("ws://backend.test:3001");
    expect(result.current.connected).toBe(false);

    act(() => latestSocket().serverOpens());

    expect(result.current.connected).toBe(true);
  });

  it("send() reports false and writes nothing while the socket is not open", () => {
    const { result } = renderHook(() => useWebSocket("ws://backend.test"));

    expect(result.current.send({ type: "chat.send" })).toBe(false);
    expect(latestSocket().sent).toEqual([]);
  });

  it("send() serializes the message as JSON and reports true once the socket is open", () => {
    const { result } = renderHook(() => useWebSocket("ws://backend.test"));
    act(() => latestSocket().serverOpens());

    expect(result.current.send({ type: "chat.send", conversationId: "c1" })).toBe(true);
    expect(latestSocket().sent).toEqual([JSON.stringify({ type: "chat.send", conversationId: "c1" })]);
  });

  it("delivers each parsed server message to onMessage and exposes it as lastMessage", () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() => useWebSocket("ws://backend.test", onMessage));
    act(() => latestSocket().serverOpens());

    act(() => latestSocket().serverSends(JSON.stringify({ type: "chat.delta", steps: [] })));

    expect(onMessage).toHaveBeenCalledExactlyOnceWith({ type: "chat.delta", steps: [] });
    expect(result.current.lastMessage).toEqual({ type: "chat.delta", steps: [] });
  });

  it("swallows keep-alive pongs and malformed frames without calling onMessage", () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() => useWebSocket("ws://backend.test", onMessage));
    act(() => latestSocket().serverOpens());

    act(() => {
      latestSocket().serverSends(JSON.stringify({ type: "pong" }));
      latestSocket().serverSends("{not json");
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(result.current.lastMessage).toBeNull();
  });

  it("calls the latest onMessage callback without opening a new connection when the callback changes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler }) => useWebSocket("ws://backend.test", handler), {
      initialProps: { handler: first },
    });
    act(() => latestSocket().serverOpens());

    rerender({ handler: second });
    act(() => latestSocket().serverSends(JSON.stringify({ type: "tools.update" })));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith({ type: "tools.update" });
  });

  it("pings every 30 seconds while the socket is open", () => {
    renderHook(() => useWebSocket("ws://backend.test"));
    act(() => latestSocket().serverOpens());

    act(() => vi.advanceTimersByTime(29_999));
    expect(latestSocket().sent).toEqual([]);

    act(() => vi.advanceTimersByTime(1));
    expect(latestSocket().sent).toEqual([JSON.stringify({ type: "ping" })]);

    act(() => vi.advanceTimersByTime(30_000));
    expect(latestSocket().sent).toHaveLength(2);
  });

  it("on a dropped connection: reports disconnected, notifies onClose, stops pinging and reconnects after 2 seconds", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useWebSocket("ws://backend.test", undefined, onClose));
    const first = latestSocket();
    act(() => first.serverOpens());

    act(() => first.connectionDrops());

    expect(result.current.connected).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(result.current.send({ type: "chat.send" })).toBe(false);
    // Only the reconnect is scheduled: the dead socket's keep-alive interval is gone.
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(1_999));
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(latestSocket().url).toBe("ws://backend.test");

    act(() => latestSocket().serverOpens());
    expect(result.current.connected).toBe(true);
    expect(result.current.send({ type: "chat.send" })).toBe(true);
    expect(latestSocket().sent).toContain(JSON.stringify({ type: "chat.send" }));
  });

  it("keeps retrying every 2 seconds while the backend stays unreachable", () => {
    renderHook(() => useWebSocket("ws://backend.test"));

    act(() => latestSocket().connectionDrops());
    act(() => vi.advanceTimersByTime(2_000));
    act(() => latestSocket().connectionDrops());
    act(() => vi.advanceTimersByTime(2_000));

    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("on unmount: closes the socket without notifying onClose and without scheduling a reconnect", () => {
    const onClose = vi.fn();
    const { unmount } = renderHook(() => useWebSocket("ws://backend.test", undefined, onClose));
    const socket = latestSocket();
    act(() => socket.serverOpens());

    unmount();

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.sent).toEqual([]);
  });

  it("cancels a pending reconnect when unmounted during the reconnect delay", () => {
    const { unmount } = renderHook(() => useWebSocket("ws://backend.test"));
    act(() => latestSocket().connectionDrops());

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(10_000));

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("replaces the connection when the URL changes", () => {
    const { result, rerender } = renderHook(({ url }) => useWebSocket(url), {
      initialProps: { url: "ws://one.test" },
    });
    const first = latestSocket();
    act(() => first.serverOpens());

    rerender({ url: "ws://two.test" });

    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    // Not connected again until the new socket opens, and the old keep-alive is gone.
    expect(result.current.connected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(latestSocket().url).toBe("ws://two.test");
  });
});
