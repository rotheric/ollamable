import { normalizeResponseSteps } from "../shared/normalize-response-steps.js";
import { DEFAULT_MAX_MODEL_INVOCATIONS, DEFAULT_MAX_TOOL_CALLS } from "../shared/execution-budget.js";
import { COMPACT_CONTEXT_TOOL_NAME, isCompactContextEnabled, lastUsedTokens, placeStepsForModel } from "../shared/context-usage.js";
import type WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { ToolDispatcher } from "./tool-executor.js";
import { WebSearchExecutor } from "./tools/web-search.js";
import { CurlExecutor } from "./tools/curl.js";
import { CompactContextExecutor, parseCompactContextArgs } from "./tools/compact-context.js";
import { McpBridge } from "./tools/mcp-bridge.js";
import { LlmRouter, UnsupportedProviderError } from "./llm-router.js";
import { loadProviderConfigs } from "./provider-config.js";
import { VocabUnavailableError } from "./tokenizer.js";
import { isRecord, validateChatRequest } from "./request-validation.js";
import type {
  ClientMessage,
  CompactionPayload,
  ConversationStep,
  MetaEvent,
  ServerMessage,
  ToolDefinition,
} from "./types.js";

/**
 * Cap on `tokenize`'s `text` field (S3-C5). 200,000 chars comfortably
 * exceeds any real chat step a user would paste (tens of thousands of
 * chars for a long document), while keeping the worst case for
 * `bpeMerge`'s O(n^2)-per-pre-token merge loop and the pre-tokenizer's
 * unbounded letter-run branch bounded to a sub-second cost per request.
 * Chosen within the finding's suggested 64k-256k range.
 */
const MAX_TOKENIZE_TEXT_LENGTH = 200_000;
// Per-request execution budget. A conversation may choose its own budget
// (persisted as a conversation setting); the server-owned ceilings below cap it.
export { DEFAULT_MAX_MODEL_INVOCATIONS, DEFAULT_MAX_TOOL_CALLS };
export const DEFAULT_MODEL_INVOCATION_CEILING = 64;
export const DEFAULT_TOOL_CALL_CEILING = 256;

export interface ExecutionLimits {
  /** Highest number of model invocations any request may spend. */
  maxModelInvocations: number;
  /** Highest number of tool calls any request may spend. */
  maxToolCalls: number;
}

function ceiling(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`Execution ceilings must be positive integers, received: ${value}`);
  }
  return Number(value);
}

/** Server-owned ceilings from BACKEND_MAX_MODEL_INVOCATIONS / BACKEND_MAX_TOOL_CALLS. */
export function loadExecutionLimits(env: Record<string, string | undefined> = process.env): ExecutionLimits {
  return {
    maxModelInvocations: ceiling(env.BACKEND_MAX_MODEL_INVOCATIONS, DEFAULT_MODEL_INVOCATION_CEILING),
    maxToolCalls: ceiling(env.BACKEND_MAX_TOOL_CALLS, DEFAULT_TOOL_CALL_CEILING),
  };
}

function budgetError(limit: number, unit: string, capped: boolean): Error {
  const origin = capped ? "server ceiling" : "conversation setting";
  return new Error(
    `Execution budget exceeded: at most ${limit} ${unit} per request (${origin}). ` +
    "Completed steps are kept; press Resume to continue, or raise the budget in the conversation settings."
  );
}

interface McpConfig {
  mcpServers?: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> }
  >;
}

export class ConnectionHandler {
  private ws: WebSocket;
  private router: LlmRouter;
  private dispatcher: ToolDispatcher;
  private mcpBridge: McpBridge;
  private generations = new Map<string, { controller: AbortController; requestId?: string }>();
  private readonly limits: ExecutionLimits;

  constructor(ws: WebSocket, router?: LlmRouter, limits: ExecutionLimits = loadExecutionLimits()) {
    this.ws = ws;
    this.limits = limits;
    this.router = router ?? new LlmRouter(loadProviderConfigs());
    this.dispatcher = new ToolDispatcher();
    this.dispatcher.register(new WebSearchExecutor());
    this.dispatcher.register(new CurlExecutor());
    // Before McpBridge construction so the name is reserved against MCP collisions.
    this.dispatcher.register(new CompactContextExecutor());
    this.mcpBridge = new McpBridge(this.dispatcher.getToolDefinitions().map((tool) => tool.name));
    this.dispatcher.register(this.mcpBridge);

    ws.on("message", (data) => {
      // A rejection here would otherwise be unhandled and abort the whole
      // process (S3-F1) — e.g. a malformed `tokenize`/`chat.send` message
      // whose shape violation throws ahead of any per-branch try/catch.
      void this.handleMessage(data.toString()).catch((err) => {
        console.error("[ws] handler error", err);
      });
    });

    ws.on("error", (error) => {
      console.warn("[ws] transport error", error.message);
    });

    ws.on("close", () => {
      for (const { controller } of this.generations.values()) {
        controller.abort();
      }
      this.generations.clear();
      void this.mcpBridge.disconnect();
    });
  }

  async initMcp(configPath?: string): Promise<ToolDefinition[]> {
    if (!configPath) return [];

    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw) as McpConfig;
      if (!config.mcpServers) return [];

      const mcpTools = await this.mcpBridge.connect(config.mcpServers, (event) =>
        this.sendMeta("init", event)
      );

      if (mcpTools.length > 0) {
        this.send({ type: "tools.update", tools: mcpTools });
      }

      return mcpTools;
    } catch {
      return [];
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send({ type: "protocol.error", message: "Invalid JSON message" });
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      this.send({ type: "protocol.error", message: "Expected a message object with a type" });
      return;
    }
    if (parsed.type === "chat.send") {
      const error = validateChatRequest(parsed);
      if (error) {
        if (typeof parsed.conversationId === "string" && parsed.conversationId.trim()) {
          this.send({ type: "chat.error", conversationId: parsed.conversationId,
            requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined,
            message: error });
        } else this.send({ type: "protocol.error", message: error });
        return;
      }
    }
    if (parsed.type === "chat.stop" && (typeof parsed.conversationId !== "string" ||
      (parsed.requestId !== undefined && typeof parsed.requestId !== "string"))) {
      this.send({ type: "protocol.error", message: "Invalid Stop request" });
      return;
    }
    const msg = parsed as unknown as ClientMessage;

    if (msg.type === "ping") {
      this.send({ type: "pong" });
      return;
    }

    if (msg.type === "chat.stop") {
      console.log(`[ws] <- chat.stop  conversation=${msg.conversationId}`);
      const generation = this.generations.get(msg.conversationId);
      if (generation && generation.requestId === msg.requestId) {
        generation.controller.abort();
      }
      return;
    }

    if (msg.type === "chat.send") {
      const toolNames = (msg.tools ?? []).map((t) => t.name).join(", ");
      console.log(
        `[ws] <- chat.send  conversation=${msg.conversationId}  model=${msg.model}  steps=${msg.steps.length}  tools=[${toolNames}]  temp=${msg.temperature ?? "default"}  maxTokens=${msg.maxOutputTokens ?? "default"}  reasoning=${msg.reasoningEffort ?? "default"}  budget=${msg.maxModelInvocations ?? "default"}/${msg.maxToolCalls ?? "default"}`
      );
      await this.handleChatSend(msg);
      return;
    }

    if (msg.type === "tokenize") {
      await this.handleTokenize(msg);
      return;
    }
    this.send({ type: "protocol.error", message: "Unknown message type" });
  }

  /**
   * Routes via `LlmRouter.tokenizeText`, which gates strictly on
   * `ProviderConfig.type` (never provider name), mirroring the existing
   * `showModelMeta` precedent (architecture.md Boundary Rule 4). An
   * explicit `provider` field threads through to the router the same way
   * `chat.send` does, so tokenize can never silently resolve to a
   * different provider than the conversation's chat when two providers
   * serve the same model name (S3-F4). A non-Ollama provider fails with
   * `reason: "unsupported_provider"`; a model reporting an unsupported
   * `tokenizer.ggml.pre` surfaces as `reason: "vocab_unavailable"`
   * (VocabUnavailableError, thrown by server/tokenizer.ts) — neither case
   * ever replies with a `tokenize.result` built from a different model's
   * vocabulary.
   *
   * `text`/`model` are validated before use: a malformed message (missing
   * or non-string fields) replies `reason: "internal"` instead of
   * throwing ahead of this try block, which would otherwise crash the
   * process via an unhandled rejection (S3-F1).
   *
   * `text` is also capped at `MAX_TOKENIZE_TEXT_LENGTH` (S3-C5): a
   * WS client can send any size payload, `bpeMerge` is O(n^2) per
   * pre-token, and the pre-tokenizer's letter-run branch
   * (`[^\r\n\p{L}\p{N}]?\p{L}+`) admits an unbounded run as a single
   * pre-token — so one oversized message can pin this process's single
   * thread. A too-long `text` replies `reason: "too_large"` instead of
   * being routed to the tokenizer at all. (The identical exposure on
   * `chat.send`'s message content is pre-existing and out of scope for
   * this story.)
   */
  private async handleTokenize(
    msg: Extract<ClientMessage, { type: "tokenize" }>
  ): Promise<void> {
    const { requestId, model, text, provider } = msg;

    if (typeof text !== "string" || typeof model !== "string") {
      this.send({ type: "tokenize.error", requestId, reason: "internal" });
      return;
    }

    if (text.length > MAX_TOKENIZE_TEXT_LENGTH) {
      console.log(
        `[ws] <- tokenize  requestId=${requestId}  model=${model}  textLength=${text.length}  rejected: too_large`
      );
      this.send({ type: "tokenize.error", requestId, reason: "too_large" });
      return;
    }

    try {
      console.log(`[ws] <- tokenize  requestId=${requestId}  model=${model}  textLength=${text.length}`);
      const { tokens, tokenIds } = await this.router.tokenizeText(provider, model, text);
      this.send({ type: "tokenize.result", requestId, tokens, tokenIds });
    } catch (error) {
      if (error instanceof VocabUnavailableError) {
        this.send({ type: "tokenize.error", requestId, reason: "vocab_unavailable" });
        return;
      }
      if (error instanceof UnsupportedProviderError) {
        this.send({ type: "tokenize.error", requestId, reason: "unsupported_provider" });
        return;
      }
      console.error(
        `[ws] tokenize error  requestId=${requestId}  model=${model}:`,
        error instanceof Error ? error.message : error
      );
      this.send({ type: "tokenize.error", requestId, reason: "internal" });
    }
  }

  private async handleChatSend(
    msg: Extract<ClientMessage, { type: "chat.send" }>
  ): Promise<void> {
    const { conversationId, model, provider, tools, temperature, maxOutputTokens, reasoningEffort } = msg;
    const { requestId } = msg;
    // The usage note exists to inform the compaction decision, so it is sent only while the tool is enabled.
    const compactEnabled = isCompactContextEnabled(tools);
    // Without a resolved window from the client the note states used tokens only (source "assumed").
    const contextWindow = msg.contextWindow === undefined || msg.contextWindowSource === undefined
      ? undefined
      : { tokens: msg.contextWindow, source: msg.contextWindowSource };
    const requestedInvocations = msg.maxModelInvocations ?? DEFAULT_MAX_MODEL_INVOCATIONS;
    const requestedToolCalls = msg.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const maxModelInvocations = Math.min(requestedInvocations, this.limits.maxModelInvocations);
    const maxToolCalls = Math.min(requestedToolCalls, this.limits.maxToolCalls);
    const previous = this.generations.get(conversationId);
    if (previous) {
      previous.controller.abort();
      this.send({ type: "chat.error", conversationId, requestId: previous.requestId, message: "Generation superseded by a newer request." });
    }
    const controller = new AbortController();
    const generation = { controller, requestId };
    this.generations.set(conversationId, generation);

    // Mutable copy of steps that we extend through the tool loop.
    // `originalCount` marks the boundary so chat.done sends only new steps.
    let steps = normalizeResponseSteps(msg.steps);
    const originalCount = steps.length;

    let loopIteration = 0;
    let toolCallCount = 0;
    // Context size after the previous invocation (the last usage of the incoming steps before the first one).
    let usedTokens = lastUsedTokens(steps);

    try {
      // Tool loop: keep calling the LLM until we get a response with no tool calls
      while (true) {
        if (controller.signal.aborted) break;
        if (loopIteration >= maxModelInvocations) {
          throw budgetError(maxModelInvocations, "model invocations", requestedInvocations > maxModelInvocations);
        }
        loopIteration++;

        console.log(`[ws] conversation=${conversationId} loop=${loopIteration} sending ${steps.length} steps to ${provider ?? "default"}/${model}`);

        // Placement is applied to a per-invocation copy only: `steps` (the accumulator behind
        // chat.steps/chat.done) and the deltas below never contain the note or transformed steps.
        const invocationSteps = placeStepsForModel(steps, {
          compactEnabled,
          usedTokens,
          window: contextWindow,
          family: msg.modelFamily,
        });
        const responseSteps = await this.router.streamResponse({
          provider,
          model,
          steps: invocationSteps,
          tools,
          temperature,
          maxOutputTokens,
          reasoningEffort,
          signal: controller.signal,
          onDelta: (partialSteps) => {
            if (controller.signal.aborted) return;
            this.send({
              type: "chat.delta",
              conversationId,
              requestId,
              steps: partialSteps,
            });
          },
        });

        controller.signal.throwIfAborted();

        // The next invocation's note reports this invocation's usage (none reported: no numbers).
        usedTokens = lastUsedTokens(responseSteps);

        // Tag each LLM-generated step with the model name
        for (const s of responseSteps) s.model = model;

        // Separate tool_call steps from other response steps
        const toolCallSteps = responseSteps.filter(
          (s) => s.kind === "tool_call" && s.toolCall
        );
        if (toolCallCount + toolCallSteps.length > maxToolCalls) {
          throw budgetError(maxToolCalls, "tool calls", requestedToolCalls > maxToolCalls);
        }

        // Prompt visibility is not authorization: history can contain disabled calls.
        const enabledNames = new Set((tools ?? []).map((tool) => tool.name));
        for (const step of toolCallSteps) {
          const name = step.toolCall!.name;
          if (!enabledNames.has(name)) {
            throw new Error(`Tool is not enabled for this request: ${name}`);
          }
          if (!this.dispatcher.canHandle(name)) {
            throw new Error(`Tool is not available on this server: ${name}`);
          }
          const selected = tools.find((tool) => tool.name === name);
          const actual = this.dispatcher.getToolDefinitions().find((tool) => tool.name === name);
          if (selected?.id !== actual?.id) {
            throw new Error(`Selected tool is no longer available: ${name}. Refresh the tool selection.`);
          }
        }

        // compact_context interception. The enablement/availability checks above have already run, so a
        // disabled call never reaches here. Every call is counted against the budget it was checked
        // against above, whether it is honored or rejected.
        const compactSteps = toolCallSteps.filter((s) => s.toolCall!.name === COMPACT_CONTEXT_TOOL_NAME);
        if (compactSteps.length > 0) {
          toolCallCount += toolCallSteps.length;
          const sole = toolCallSteps.length === 1;
          const parsed = sole ? parseCompactContextArgs(compactSteps[0].toolCall!.arguments) : undefined;
          const rejection = !sole
            ? (step: ConversationStep) => step.toolCall!.name === COMPACT_CONTEXT_TOOL_NAME
              ? "compact_context was not executed: it must be the only tool call in a response. Call it again on its own; nothing was compacted."
              : `${step.toolCall!.name} was not executed because the same response contained compact_context, which must be the only tool call. Call it again separately.`
            : parsed && !parsed.ok
              ? () => parsed.error
              : undefined;
          const makeResult = (step: ConversationStep, content: string): ConversationStep => ({
            id: randomUUID(),
            kind: "tool_result",
            title: `Result: ${step.toolCall!.name}`,
            content,
            createdAt: new Date().toISOString(),
            expanded: true,
            toolResult: { id: step.toolCall!.id, name: step.toolCall!.name },
          });

          if (!rejection && parsed?.ok) {
            const toolCallStep = compactSteps[0];
            const compaction: CompactionPayload = {
              toolCallStepId: toolCallStep.id,
              summary: parsed.summary,
              ...(parsed.remainingWork !== undefined ? { remainingWork: parsed.remainingWork } : {}),
            };
            // No tool_result: nothing is sent back to the model, so none is fabricated. The client
            // records the takeover as a harness event instead.
            const allNewSteps = [...steps.slice(originalCount), ...responseSteps];
            console.log(`[ws] conversation=${conversationId} compaction after ${loopIteration} loop(s), returning ${allNewSteps.length} new step(s)`);
            this.send({ type: "chat.done", conversationId, requestId, steps: allNewSteps, compaction });
            break;
          }

          // Rejected: error tool_results for EVERY call, nothing executed, then the model sees them.
          const errorResults = toolCallSteps.map((step) =>
            makeResult(step, JSON.stringify({ error: rejection!(step) })));
          console.log(`[ws] conversation=${conversationId} loop=${loopIteration} compact_context rejected (${toolCallSteps.length} call(s))`);
          this.send({ type: "chat.steps", conversationId, requestId, steps: responseSteps });
          this.send({ type: "chat.steps", conversationId, requestId, steps: errorResults });
          steps = [...steps, ...responseSteps, ...errorResults];
          continue;
        }

        const executableToolCalls = toolCallSteps.filter(
          (s) => s.toolCall && this.dispatcher.canHandle(s.toolCall.name)
        );

        console.log(
          `[ws] conversation=${conversationId} loop=${loopIteration} LLM returned ${responseSteps.length} step(s): ${responseSteps.map((s) => s.kind).join(", ")}` +
          (toolCallSteps.length > 0 ? ` | tool_calls=[${toolCallSteps.map((s) => s.toolCall!.name).join(", ")}] (${executableToolCalls.length} executable)` : "")
        );

        if (executableToolCalls.length === 0) {
          // No executable tool calls — we're done.
          const allNewSteps = [...steps.slice(originalCount), ...responseSteps];
          console.log(`[ws] conversation=${conversationId} done after ${loopIteration} loop(s), returning ${allNewSteps.length} new step(s)`);
          this.send({
            type: "chat.done",
            conversationId,
            requestId,
            steps: allNewSteps,
          });
          break;
        }

        // Preserve protocol calls separately from authentic assistant prose.
        this.send({
          type: "chat.steps",
          conversationId,
          requestId,
          steps: responseSteps,
        });

        // Execute tools, emitting harness steps for each
        const toolResultSteps: ConversationStep[] = [];

        for (const toolStep of executableToolCalls) {
          controller.signal.throwIfAborted();
          toolCallCount++;
          const { name, arguments: toolArgs } = toolStep.toolCall!;
          const argSummary = JSON.stringify(toolArgs);
          const truncatedArgs = argSummary.length > 200 ? argSummary.slice(0, 200) + "…" : argSummary;

          console.log(`[ws] conversation=${conversationId} tool.exec ${name} args=${truncatedArgs}`);

          // Use a stable ID so the in-progress step gets replaced by the final result
          const stepId = randomUUID();

          // Send in-progress tool_result (same kind/ID as final result)
          this.send({
            type: "chat.steps",
            conversationId,
            requestId,
            steps: [{
              id: stepId,
              kind: "tool_result",
              title: `Executing: ${name}`,
              content: JSON.stringify(toolArgs, null, 2),
              createdAt: new Date().toISOString(),
              expanded: true,
              toolResult: { id: toolStep.toolCall!.id, name },
            }],
          });

          const startTime = Date.now();
          const result = await this.dispatcher.execute(
            name,
            toolArgs,
            (event) => {
              if (!controller.signal.aborted) this.sendMeta(conversationId, event, requestId);
            },
            controller.signal
          );
          controller.signal.throwIfAborted();
          const durationMs = Date.now() - startTime;
          const truncatedResult = result.length > 300 ? result.slice(0, 300) + "…" : result;

          console.log(`[ws] conversation=${conversationId} tool.done ${name} ${durationMs}ms result=${truncatedResult}`);

          const toolResultStep: ConversationStep = {
            id: stepId,
            kind: "tool_result",
            title: `Result: ${name}`,
            content: result,
            createdAt: new Date().toISOString(),
            expanded: true,
            toolResult: { id: toolStep.toolCall!.id, name },
          };
          toolResultSteps.push(toolResultStep);
        }

        // Send tool results (response back to LLM) to frontend
        this.send({
          type: "chat.steps",
          conversationId,
          requestId,
          steps: toolResultSteps,
        });

        // Append provider response records and tool results for the next invocation
        steps = [...steps, ...responseSteps, ...toolResultSteps];
      }
    } catch (error) {
      if (controller.signal.aborted) {
        console.log(`[ws] conversation=${conversationId} aborted by client`);
        return;
      }
      const message =
        error instanceof Error ? error.message : "Unknown server error";
      console.error(`[ws] conversation=${conversationId} error: ${message}`);
      this.send({ type: "chat.error", conversationId, requestId, message });
    } finally {
      if (this.generations.get(conversationId) === generation) this.generations.delete(conversationId);
    }
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendMeta(conversationId: string, event: MetaEvent, requestId?: string): void {
    this.send({ type: "meta.event", conversationId, requestId, event });
  }
}
