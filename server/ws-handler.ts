import type WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { ToolDispatcher } from "./tool-executor.js";
import { WebSearchExecutor } from "./tools/web-search.js";
import { CurlExecutor } from "./tools/curl.js";
import { McpBridge } from "./tools/mcp-bridge.js";
import { LlmRouter, UnsupportedProviderError } from "./llm-router.js";
import { loadProviderConfigs } from "./provider-config.js";
import { VocabUnavailableError } from "./tokenizer.js";
import type {
  ClientMessage,
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
  private abortControllers = new Map<string, AbortController>();

  constructor(ws: WebSocket, router?: LlmRouter) {
    this.ws = ws;
    this.router = router ?? new LlmRouter(loadProviderConfigs());
    this.dispatcher = new ToolDispatcher();
    this.mcpBridge = new McpBridge();

    this.dispatcher.register(new WebSearchExecutor());
    this.dispatcher.register(new CurlExecutor());
    this.dispatcher.register(this.mcpBridge);

    ws.on("message", (data) => {
      // A rejection here would otherwise be unhandled and abort the whole
      // process (S3-F1) — e.g. a malformed `tokenize`/`chat.send` message
      // whose shape violation throws ahead of any per-branch try/catch.
      void this.handleMessage(data.toString()).catch((err) => {
        console.error("[ws] handler error", err);
      });
    });

    ws.on("close", () => {
      for (const controller of this.abortControllers.values()) {
        controller.abort();
      }
      this.abortControllers.clear();
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
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    if (msg.type === "ping") {
      this.send({ type: "pong" });
      return;
    }

    if (msg.type === "chat.stop") {
      console.log(`[ws] <- chat.stop  conversation=${msg.conversationId}`);
      const controller = this.abortControllers.get(msg.conversationId);
      if (controller) {
        controller.abort();
        this.abortControllers.delete(msg.conversationId);
      }
      return;
    }

    if (msg.type === "chat.send") {
      const toolNames = (msg.tools ?? []).map((t) => t.name).join(", ");
      console.log(
        `[ws] <- chat.send  conversation=${msg.conversationId}  model=${msg.model}  steps=${msg.steps.length}  tools=[${toolNames}]  temp=${msg.temperature ?? "default"}  maxTokens=${msg.maxOutputTokens ?? "default"}  reasoning=${msg.reasoningEffort ?? "default"}`
      );
      await this.handleChatSend(msg);
      return;
    }

    if (msg.type === "tokenize") {
      await this.handleTokenize(msg);
      return;
    }
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
    const controller = new AbortController();
    this.abortControllers.set(conversationId, controller);

    // Mutable copy of steps that we extend through the tool loop.
    // `originalCount` marks the boundary so chat.done sends only new steps.
    let steps = [...msg.steps];
    const originalCount = steps.length;

    let loopIteration = 0;

    try {
      // Tool loop: keep calling the LLM until we get a response with no tool calls
      while (true) {
        if (controller.signal.aborted) break;
        loopIteration++;

        console.log(`[ws] conversation=${conversationId} loop=${loopIteration} sending ${steps.length} steps to ${provider ?? "default"}/${model}`);

        const responseSteps = await this.router.streamResponse({
          provider,
          model,
          steps,
          tools,
          temperature,
          maxOutputTokens,
          reasoningEffort,
          signal: controller.signal,
          onDelta: (partialSteps) => {
            this.send({
              type: "chat.delta",
              conversationId,
              steps: partialSteps,
            });
          },
        });

        // Tag each LLM-generated step with the model name
        for (const s of responseSteps) s.model = model;

        // Separate tool_call steps from other response steps
        const toolCallSteps = responseSteps.filter(
          (s) => s.kind === "tool_call" && s.toolCall
        );
        const mergedSteps = responseSteps.filter(
          (s) => s.kind !== "tool_call"
        );

        // Merge tool calls into the assistant step as toolCalls[]
        if (toolCallSteps.length > 0) {
          let assistantStep = mergedSteps.find((s) => s.kind === "assistant");
          if (!assistantStep) {
            assistantStep = {
              id: randomUUID(),
              kind: "assistant",
              title: "Assistant",
              content: "",
              createdAt: new Date().toISOString(),
              expanded: true,
            };
            mergedSteps.push(assistantStep);
          }
          assistantStep.toolCalls = toolCallSteps.map((s) => s.toolCall!);
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
          const allNewSteps = [...steps.slice(originalCount), ...mergedSteps];
          console.log(`[ws] conversation=${conversationId} done after ${loopIteration} loop(s), returning ${allNewSteps.length} new step(s)`);
          this.send({
            type: "chat.done",
            conversationId,
            steps: allNewSteps,
          });
          break;
        }

        // Send merged assistant (with toolCalls) to frontend
        this.send({
          type: "chat.steps",
          conversationId,
          steps: mergedSteps,
        });

        // Execute tools, emitting harness steps for each
        const toolResultSteps: ConversationStep[] = [];

        for (const toolStep of executableToolCalls) {
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
            (event) => this.sendMeta(conversationId, event)
          );
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
          steps: toolResultSteps,
        });

        // Append merged steps + tool results for next LLM iteration
        steps = [...steps, ...mergedSteps, ...toolResultSteps];
      }
    } catch (error) {
      if (controller.signal.aborted) {
        console.log(`[ws] conversation=${conversationId} aborted by client`);
        return;
      }
      const message =
        error instanceof Error ? error.message : "Unknown server error";
      console.error(`[ws] conversation=${conversationId} error: ${message}`);
      this.send({ type: "chat.error", conversationId, message });
    } finally {
      this.abortControllers.delete(conversationId);
    }
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendMeta(conversationId: string, event: MetaEvent): void {
    this.send({ type: "meta.event", conversationId, event });
  }
}
