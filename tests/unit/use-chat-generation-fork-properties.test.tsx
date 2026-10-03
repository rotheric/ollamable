/**
 * Compaction-tool S7, AC-STRUCT-6: client-event interleavings for one original request, driven
 * through the real `useChatGeneration` (+ `buildFork`, `stream-steps`) with only the backend
 * client's stream doubled. The conversation store is a faithful minimum of `useConversations`:
 * an update addressed to a conversation that is not in state is dropped (and recorded), exactly
 * as the real list does, so "the fork is in state before ..." is observable.
 *
 * The oracle is a tiny ownership model written from the AC / architecture.md Order-Sensitive
 * Composition, not from the hook: a single token (`stopStreamRef`) belongs to the latest started
 * generation until it settles; only the token holder may settle the UI or fork; `settledCount`
 * bumps once per settling token holder, the compaction original included. No stream is ever
 * started for a fork: the user's first message there is a normal send.
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import fc from "fast-check";
import { useChatGeneration } from "@/src/lib/use-chat-generation";
import { createConversation } from "@/src/lib/chat";
import type { BackendClient } from "@/src/lib/backend-client";
import type { CompactionPayload, Conversation, ConversationStep } from "@/src/types/chat";

const SEED = Number(process.env.FC_SEED ?? 20261002);

type EventKind = "delta" | "stop" | "supersede" | "done" | "doneCompaction";
const eventArb = fc.constantFrom<EventKind>("delta", "stop", "supersede", "done", "doneCompaction");
const scenarioArb = fc.record({
  events: fc.array(eventArb, { maxLength: 9 }),
});

const compactTool = { id: "compact-context", name: "compact_context", description: "d", inputSchema: "{}" };
const searchTool = { id: "web-search", name: "web_search", description: "d", inputSchema: "{}" };
const original: Conversation = {
  ...createConversation("a:latest", [compactTool, searchTool], "ollama"),
  id: "original",
  title: "Notes",
  activeToolIds: [compactTool.id, searchTool.id],
};
const payload: CompactionPayload = { toolCallStepId: "tc-1", summary: "SUM", remainingWork: "RW" };
const DONE_MARKER = "original-done-step";
const DELTA_MARKER = "partial-delta";

const assistant = (id: string, content: string): ConversationStep => ({
  id, kind: "assistant", title: "Assistant", content, createdAt: "2026-01-01T00:00:00.000Z",
});

interface Stream {
  conversationId: string;
  request: { onDelta: (steps: ConversationStep[]) => void; onCompaction: (p: CompactionPayload) => void };
  settled: boolean;
  resolve: (steps: ConversationStep[]) => void;
  reject: (error: Error) => void;
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function runScenario({ events }: { events: EventKind[] }) {
  const store = new Map<string, Conversation>([[original.id, original]]);
  const dropped: string[] = [];
  const streams: Stream[] = [];
  const stopLog: number[] = [];
  const forks: Conversation[] = [];
  let originalHadDoneStepsAtFork: boolean | undefined;

  const startStream = vi.fn((_send: unknown, request: Stream["request"] & { conversationId: string; tools: Array<{ name: string }> }) => {
    let resolve!: Stream["resolve"];
    let reject!: Stream["reject"];
    const promise = new Promise<ConversationStep[]>((res, rej) => { resolve = res; reject = rej; });
    const index = streams.length;
    const stream: Stream = { conversationId: request.conversationId, request, settled: false, resolve, reject };
    streams.push(stream);
    return {
      promise,
      stop: () => {
        stopLog.push(index);
        if (!stream.settled) { stream.settled = true; reject(new Error("AbortError")); }
      },
    };
  });

  const updateConversation = vi.fn((id: string, updater: (c: Conversation) => Conversation) => {
    const current = store.get(id);
    if (!current) { dropped.push(id); return; }
    store.set(id, updater(current));
  });
  const onFork = vi.fn((fork: Conversation) => {
    forks.push(fork);
    originalHadDoneStepsAtFork = store.get(original.id)!.steps.some((s) => s.content === DONE_MARKER);
    store.set(fork.id, fork);
  });

  const { result, unmount } = renderHook(() =>
    useChatGeneration({
      backendClient: { startStream } as unknown as BackendClient,
      send: () => true, connected: true, availableModels: [], updateConversation,
      defaultExpanded: () => false, setError: vi.fn(), onFork,
    })
  );

  // Ownership model.
  let owner: number | null = null;
  let bumps = 0;
  let forkExpected = false;
  let supersessions = 0;
  let originalApplied = false;
  let stopTarget: number | null = null;

  const settleOwned = (index: number) => { if (owner === index) { owner = null; bumps++; } };

  // The original starts first.
  act(() => { void result.current.streamConversationResponse(original); });
  owner = 0;

  for (const event of events) {
    const stopsBefore = stopLog.length;
    await act(async () => {
      const first = streams[0];
      switch (event) {
        case "delta":
          if (!first.settled) first.request.onDelta([assistant("p", DELTA_MARKER)]);
          break;
        case "stop": {
          stopTarget = owner;
          result.current.stopGeneration();
          if (stopTarget !== null) settleOwned(stopTarget);
          break;
        }
        case "supersede": {
          const other = { ...original, id: `other-${supersessions++}` };
          store.set(other.id, other);
          void result.current.streamConversationResponse(other);
          owner = streams.length - 1;
          break;
        }
        case "done":
          if (!first.settled) { first.settled = true; first.resolve([assistant("o", DONE_MARKER)]); originalApplied ||= owner === 0; settleOwned(0); }
          break;
        case "doneCompaction":
          if (!first.settled) {
            first.request.onCompaction(payload);
            first.settled = true;
            first.resolve([assistant("o", DONE_MARKER)]);
            if (owner === 0) {
              originalApplied = true;
              forkExpected = true;
              settleOwned(0);
            }
          }
          break;
      }
      await flush();
    });

    // A stop reaches exactly the token holder's stream and nobody else's (the original's finally never stole the fork's token).
    if (event === "stop") {
      expect(stopLog.slice(stopsBefore)).toEqual(stopTarget === null ? [] : [stopTarget]);
    }
    expect(forks.length).toBe(forkExpected ? 1 : 0);
    // The original's response steps are applied exactly when it still owned the generation as it finished.
    expect(store.get(original.id)!.steps.some((s) => s.content === DONE_MARKER)).toBe(originalApplied);
    expect(result.current.settledCount).toBe(bumps);
    expect(result.current.streaming).toBe(owner !== null);
  }

  // Drain: every still-pending stream ends with a plain response.
  for (let i = 0; i < streams.length; i++) {
    if (streams[i].settled) continue;
    await act(async () => { streams[i].settled = true; streams[i].resolve([]); await flush(); });
    settleOwned(i);
  }

  const outcome = { forks, dropped, originalHadDoneStepsAtFork, settledCount: result.current.settledCount, streaming: result.current.streaming, bumps, forkExpected, streams, store, startStream };
  unmount();
  return outcome;
}

describe("AC-STRUCT-6: fork exists iff a compaction chat.done was applied while the original owned the generation", () => {
  it("generators reach every event kind, the fork case and the no-fork cases", () => {
    const samples = fc.sample(scenarioArb, { numRuns: 400, seed: SEED });
    const kinds = new Set(samples.flatMap((s) => s.events));
    expect(kinds).toEqual(new Set<EventKind>(["delta", "stop", "supersede", "done", "doneCompaction"]));
    const firstTerminal = (events: EventKind[]) => events.find((e) => e === "done" || e === "doneCompaction" || e === "stop" || e === "supersede");
    const firsts = new Set(samples.map((s) => firstTerminal(s.events)));
    expect(firsts).toEqual(new Set<EventKind | undefined>(["done", "doneCompaction", "stop", "supersede", undefined]));
  });

  it("holds for every generated interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const out = await runScenario(scenario);

        // The whole run was predicted by the ownership model per event (asserted inside runScenario); here the end state.
        expect(out.streaming).toBe(false);
        expect(out.settledCount).toBe(out.bumps);
        expect(out.forks.length).toBe(out.forkExpected ? 1 : 0);

        // No update was ever addressed to a conversation that was not in state yet.
        expect(out.dropped).toEqual([]);

        if (out.forkExpected) {
          const fork = out.forks[0];
          // The original's chat.done steps were applied to the original before the fork existed.
          expect(out.originalHadDoneStepsAtFork).toBe(true);
          expect(fork.forkedFrom).toEqual({ conversationId: "original", stepId: payload.toolCallStepId });
          // Nothing was ever sent for the fork, and it carries no request record yet.
          expect(out.streams.every((s) => s.conversationId === "original" || s.conversationId.startsWith("other-"))).toBe(true);
          expect(out.store.get(fork.id)!.requestContexts).toEqual([]);
          // The original gained exactly one harness step, after its chat.done steps, naming this fork.
          const originalSteps = out.store.get("original")!.steps;
          const harness = originalSteps.filter((s) => s.kind === "meta" && s.metaEvent?.kind === "compaction");
          expect(harness).toHaveLength(1);
          expect(harness[0].metaEvent!.data).toEqual({ forkConversationId: fork.id });
          expect(originalSteps.indexOf(harness[0])).toBeGreaterThan(originalSteps.findIndex((s) => s.content === DONE_MARKER));
        } else {
          expect(out.store.get("original")!.steps.some((s) => s.kind === "meta")).toBe(false);
          // No stream other than the original and explicit supersessions ever started.
          expect(out.streams.every((s) => s.conversationId === "original" || s.conversationId.startsWith("other-"))).toBe(true);
        }
      }),
      { numRuns: 100, seed: SEED }
    );
  });
});
