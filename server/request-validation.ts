import type { IncomingMessage } from "node:http";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function optionalString(value: unknown): boolean { return value === undefined || nonempty(value); }
function toolCall(value: unknown): boolean {
  return isRecord(value) && nonempty(value.name) && optionalString(value.id) && isRecord(value.arguments);
}
const STEP_KINDS = new Set(["system", "user", "assistant", "reasoning", "tool_call", "tool_result", "meta"]);

export function validateChatRequest(message: Record<string, unknown>): string | undefined {
  if (!nonempty(message.conversationId) || !optionalString(message.requestId)) return "Invalid conversationId or requestId";
  if (!nonempty(message.model) || !optionalString(message.provider)) return "Invalid model or provider";
  if (!Array.isArray(message.steps) || !message.steps.every((step) =>
    isRecord(step) && nonempty(step.id) && typeof step.kind === "string" && STEP_KINDS.has(step.kind) &&
    typeof step.content === "string" && typeof step.title === "string" && typeof step.createdAt === "string" &&
    (step.toolCall === undefined || toolCall(step.toolCall)) &&
    (step.toolCalls === undefined || (Array.isArray(step.toolCalls) && step.toolCalls.every(toolCall))) &&
    (step.toolResult === undefined || (isRecord(step.toolResult) && nonempty(step.toolResult.name) && optionalString(step.toolResult.id)))
  )) return "Invalid conversation steps";
  if (message.tools !== undefined && (!Array.isArray(message.tools) || !message.tools.every((tool) => {
    if (!isRecord(tool) || !nonempty(tool.id) || !nonempty(tool.name) || typeof tool.description !== "string" || typeof tool.inputSchema !== "string") return false;
    try { return isRecord(JSON.parse(tool.inputSchema)); } catch { return false; }
  }))) return "Invalid tool definitions";
  if (Array.isArray(message.tools)) {
    const names = new Set(message.tools.map((tool) => tool.name));
    const ids = new Set(message.tools.map((tool) => tool.id));
    if (names.size !== message.tools.length || ids.size !== message.tools.length) return "Duplicate tool names or IDs";
  }
  if (message.temperature !== undefined && (typeof message.temperature !== "number" || !Number.isFinite(message.temperature))) return "Invalid temperature";
  if (message.maxOutputTokens !== undefined && (typeof message.maxOutputTokens !== "number" || !Number.isInteger(message.maxOutputTokens) || message.maxOutputTokens < 1)) return "Invalid maxOutputTokens";
  if (message.reasoningEffort !== undefined && !["disable", "low", "medium", "high"].includes(message.reasoningEffort as string)) return "Invalid reasoningEffort";
}

export class HttpInputError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Limits retained bytes and elapsed upload time; callers close rejected requests. */
export function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error: HttpInputError) => { cleanup(); req.pause(); reject(error); };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { fail(new HttpInputError(413, "Request body exceeds 64 KiB")); return; }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpInputError(400, "Invalid JSON body")); }
    };
    const onError = () => fail(new HttpInputError(400, "Request upload failed"));
    const onAborted = () => fail(new HttpInputError(400, "Request upload aborted"));
    const timer = setTimeout(() => fail(new HttpInputError(408, "Request upload timed out")), 10_000);
    timer.unref();
    if (Number(req.headers["content-length"]) > maxBytes) { fail(new HttpInputError(413, "Request body exceeds 64 KiB")); return; }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}
