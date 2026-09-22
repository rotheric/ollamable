import type {
  ConversationStep,
  MetaEventPayload,
  ReasoningEffort,
  ToolDefinition,
  TokenizeRequestMessage,
  TokenizeResponseMessage,
} from "@/src/types/chat";
import { createId } from "@/src/lib/chat";

/** A tokenize round trip that never hears back (send silently swallowed by
 *  a not-yet-open socket, server never replies, connection drops mid
 *  flight) rejects after this long instead of leaking its `pendingTokenize`
 *  entry and leaving the step stuck on `pending` forever (S3-F2). */
const TOKENIZE_TIMEOUT_MS = 10_000;

/**
 * Narrows `raw` to a `TokenizeResponseMessage` (S3-F9) — validates every
 * field the two variants carry, since `raw` arrives as `unknown` off the
 * wire and the type only describes what a well-formed message looks
 * like, not what's guaranteed at runtime. A `tokenize.result` missing
 * `tokens`/`tokenIds`, or a `tokenize.error` missing `reason`, is
 * rejected as malformed (returns null) rather than resolved/rejected
 * with holes (S3-R3) — the caller's message-routing falls through and
 * the call times out, which is more honest than `undefined` tokens or an
 * `Error("undefined")`.
 */
function asTokenizeResponse(raw: unknown): TokenizeResponseMessage | null {
  const msg = raw as {
    type?: unknown;
    requestId?: unknown;
    tokens?: unknown;
    tokenIds?: unknown;
    reason?: unknown;
  };
  if (typeof msg.requestId !== "string") return null;
  if (msg.type === "tokenize.result") {
    if (!Array.isArray(msg.tokens) || !Array.isArray(msg.tokenIds)) return null;
    return raw as TokenizeResponseMessage;
  }
  if (msg.type === "tokenize.error") {
    if (typeof msg.reason !== "string") return null;
    return raw as TokenizeResponseMessage;
  }
  return null;
}

function getWsUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }
  return "ws://localhost:3000";
}

export const WS_URL = getWsUrl();

interface ServerMessage {
  type: string;
  conversationId?: string;
  steps?: ConversationStep[];
  message?: string;
  event?: {
    id: string;
    kind: string;
    title: string;
    detail: string;
    data?: Record<string, unknown>;
    timestamp: string;
    durationMs?: number;
  };
}

interface PendingTokenize {
  resolve: (result: { tokens: string[]; tokenIds: number[] }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StreamRequest {
  conversationId: string;
  model: string;
  provider?: string;
  steps: ConversationStep[];
  tools: ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  onDelta: (steps: ConversationStep[]) => void;
  onStableSteps: (steps: ConversationStep[]) => void;
  onMetaEvent: (step: ConversationStep) => void;
}

interface PendingStream {
  request: StreamRequest;
  resolve: (steps: ConversationStep[]) => void;
  reject: (error: Error) => void;
}

export class BackendClient {
  private pending = new Map<string, PendingStream>();
  /**
   * Keyed by requestId, independent of `pending` (keyed by conversationId).
   * `tokenize.result`/`tokenize.error` must be handled ahead of the
   * conversationId guard below — architecture.md's Implementation
   * Constraint 1 — since those messages carry no `conversationId` at all
   * and would otherwise be silently dropped by it.
   */
  private pendingTokenize = new Map<string, PendingTokenize>();

  handleServerMessage(raw: unknown): void {
    const tokenizeMsg = asTokenizeResponse(raw);
    if (tokenizeMsg) {
      const tokenizeCall = this.pendingTokenize.get(tokenizeMsg.requestId);
      if (!tokenizeCall) return;
      this.pendingTokenize.delete(tokenizeMsg.requestId);
      clearTimeout(tokenizeCall.timer);
      if (tokenizeMsg.type === "tokenize.result") {
        tokenizeCall.resolve({ tokens: tokenizeMsg.tokens, tokenIds: tokenizeMsg.tokenIds });
      } else {
        tokenizeCall.reject(new Error(tokenizeMsg.reason));
      }
      return;
    }

    const msg = raw as ServerMessage;
    if (!msg.type || !msg.conversationId) return;

    const stream = this.pending.get(msg.conversationId);
    if (!stream) return;

    if (msg.type === "chat.delta" && msg.steps) {
      stream.request.onDelta(msg.steps);
    }

    if (msg.type === "chat.steps" && msg.steps) {
      stream.request.onStableSteps(msg.steps);
    }

    if (msg.type === "chat.done" && msg.steps) {
      this.pending.delete(msg.conversationId);
      stream.resolve(msg.steps);
    }

    if (msg.type === "chat.error") {
      this.pending.delete(msg.conversationId);
      stream.reject(new Error(msg.message ?? "Server error"));
    }

    if (msg.type === "meta.event" && msg.event) {
      const metaStep: ConversationStep = {
        id: `meta-${msg.event.id}`,
        kind: "meta",
        title: msg.event.title,
        content: msg.event.detail,
        createdAt: msg.event.timestamp,
        expanded: true,
        metaEvent: {
          kind: msg.event.kind as MetaEventPayload["kind"],
          title: msg.event.title,
          detail: msg.event.detail,
          data: msg.event.data,
          durationMs: msg.event.durationMs,
        },
      };
      stream.request.onMetaEvent(metaStep);
    }
  }

  startStream(
    send: (data: unknown) => boolean,
    request: StreamRequest
  ): { promise: Promise<ConversationStep[]>; stop: () => void } {
    const { conversationId, model, provider, steps, tools, temperature, maxOutputTokens, reasoningEffort } = request;

    const promise = new Promise<ConversationStep[]>((resolve, reject) => {
      this.pending.set(conversationId, { request, resolve, reject });
    });

    send({
      type: "chat.send",
      conversationId,
      model,
      provider,
      steps,
      tools,
      temperature,
      maxOutputTokens,
      reasoningEffort,
    });

    const stop = () => {
      send({ type: "chat.stop", conversationId });
      const stream = this.pending.get(conversationId);
      if (stream) {
        this.pending.delete(conversationId);
        stream.reject(new Error("AbortError"));
      }
    };

    return { promise, stop };
  }

  /**
   * Tokenizes `text` against `model`'s vocabulary via the server tokenizer
   * (epic-token-view story S3). Mints its own `requestId` and resolves on
   * the matching `tokenize.result` — independent of the conversationId-
   * keyed `pending` map above, since a tokenize round trip carries no
   * conversationId at all.
   *
   * Rejects immediately if `send` reports the socket wasn't open (S3-F2):
   * without this, a call made during the reconnect window would still
   * register a `pendingTokenize` entry and return a promise that never
   * settles. Otherwise rejects after `TOKENIZE_TIMEOUT_MS` if nothing
   * ever answers (server never replies, or the connection drops mid
   * flight without an `onclose`-driven `cancelPendingTokenize()` — see
   * src/lib/use-websocket.ts's `onClose` hook) so the entry can never
   * leak forever either way.
   */
  tokenize(
    send: (data: unknown) => boolean,
    model: string,
    text: string,
    provider?: string
  ): Promise<{ tokens: string[]; tokenIds: number[] }> {
    const requestId = createId();
    return new Promise<{ tokens: string[]; tokenIds: number[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTokenize.delete(requestId);
        reject(new Error("tokenize timed out"));
      }, TOKENIZE_TIMEOUT_MS);
      this.pendingTokenize.set(requestId, { resolve, reject, timer });

      const message: TokenizeRequestMessage = { type: "tokenize", requestId, model, text, provider };
      try {
        const sent = send(message);
        if (!sent) {
          clearTimeout(timer);
          this.pendingTokenize.delete(requestId);
          reject(new Error("tokenize failed: socket not open"));
        }
      } catch (err) {
        // S3-R6: `send` throwing (rather than returning false) must go
        // through the same cleanup as the `!sent` branch above — otherwise
        // the timer and pendingTokenize entry outlive the throw and only
        // the 10s sweep ever clears them.
        clearTimeout(timer);
        this.pendingTokenize.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Drains only the `pendingTokenize` map, rejecting every in-flight
   * tokenize call with `AbortError` (the server aborts its own tokenize
   * handling on a closed socket, so these calls are genuinely dead).
   * Deliberately narrower than `cancelAll()` (S3-R1): a WS close/reconnect
   * should not also reject in-flight CHAT streams — that rejection is
   * what makes `chat-workspace.tsx`'s `isAbort` check fire and show
   * "Generation stopped." on a routine reconnect, which is wrong for a
   * transient network drop. `cancelAll()` remains for intentional full
   * teardown of both maps.
   */
  cancelPendingTokenize(): void {
    for (const [id, tokenizeCall] of this.pendingTokenize) {
      clearTimeout(tokenizeCall.timer);
      tokenizeCall.reject(new Error("AbortError"));
      this.pendingTokenize.delete(id);
    }
  }

  cancelAll(): void {
    for (const [id, stream] of this.pending) {
      stream.reject(new Error("AbortError"));
      this.pending.delete(id);
    }
    this.cancelPendingTokenize();
  }
}
