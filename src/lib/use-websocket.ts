import { useCallback, useEffect, useRef, useState } from "react";

const RECONNECT_DELAY_MS = 2000;
const PING_INTERVAL_MS = 30_000;

export interface UseWebSocketResult {
  /** Returns whether the message was actually sent (socket was OPEN) —
   *  callers with their own pending-request bookkeeping (e.g.
   *  BackendClient.tokenize()) use this to reject immediately instead of
   *  registering a promise that a silently-dropped send would leave
   *  pending forever (S3-F2). */
  send: (data: unknown) => boolean;
  connected: boolean;
  lastMessage: unknown | null;
}

export function useWebSocket(
  url: string,
  onMessage?: (data: unknown) => void,
  /** Invoked whenever the socket closes (including ahead of an automatic
   *  reconnect attempt), so callers can reject anything correlated to the
   *  now-dead connection instead of leaving it pending across a reconnect
   *  that starts a brand-new server-side connection (S3-F2). Does NOT fire
   *  on intentional unmount teardown (S3-R7): the cleanup effect below
   *  nulls out `onclose` before calling `close()` specifically to suppress
   *  the reconnect attempt, and that also suppresses this callback. */
  onClose?: () => void
): UseWebSocketResult {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<unknown | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  const onCloseRef = useRef(onClose);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  onMessageRef.current = onMessage;
  onCloseRef.current = onClose;

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (pingTimer.current) {
      clearInterval(pingTimer.current);
      pingTimer.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    cleanup();

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === "pong") return;
        setLastMessage(data);
        onMessageRef.current?.(data);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      cleanup();
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
      onCloseRef.current?.();
    };

    ws.onerror = () => {
      // onclose will fire after onerror, triggering reconnect
    };
  }, [url, cleanup]);

  useEffect(() => {
    connect();
    return () => {
      cleanup();
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on intentional cleanup
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [connect, cleanup]);

  const send = useCallback((data: unknown): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      return true;
    }
    return false;
  }, []);

  return { send, connected, lastMessage };
}
