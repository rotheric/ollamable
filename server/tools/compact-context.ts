import type { ToolExecutor } from "../tool-executor.js";
import type { ToolDefinition } from "../types.js";
import { COMPACT_CONTEXT_TOOL_NAME } from "../../shared/context-usage.js";

/** Stable id shared by `GET /tools` and every connection's dispatcher (the request's tool selection is matched on it). */
export const COMPACT_CONTEXT_TOOL_ID = "compact-context";

export type CompactContextArgs =
  | { ok: true; summary: string; remainingWork?: string }
  | { ok: false; error: string };

/**
 * Validates model-supplied arguments independently of the dispatcher's schema validation, so the
 * tool loop can turn any violation into an error tool_result instead of an exception.
 * `remainingWork` is omitted (never empty) when the model gave none.
 */
export function parseCompactContextArgs(args: unknown): CompactContextArgs {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, error: "compact_context expects an object with a summary string." };
  }
  const record = args as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => key !== "summary" && key !== "remaining_work");
  if (unknownKey !== undefined) {
    return { ok: false, error: `compact_context does not accept the property "${unknownKey}".` };
  }
  const { summary, remaining_work: remainingWork } = record;
  if (typeof summary !== "string" || !summary.trim()) {
    return { ok: false, error: "compact_context requires a non-empty summary string; nothing was compacted." };
  }
  if (remainingWork !== undefined && typeof remainingWork !== "string") {
    return { ok: false, error: "compact_context remaining_work must be a string when given." };
  }
  return typeof remainingWork === "string" && remainingWork.trim()
    ? { ok: true, summary, remainingWork }
    : { ok: true, summary };
}

/**
 * Built-in tool that lets the model hand over its work as a summary. The tool loop intercepts the
 * call (see ConnectionHandler), so `execute` is only a validating fallback that is never reached
 * on the compaction path; it exists so the tool is a first-class registry entry.
 */
export class CompactContextExecutor implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        id: COMPACT_CONTEXT_TOOL_ID,
        name: COMPACT_CONTEXT_TOOL_NAME,
        description:
          "Compacts the conversation. Call it alone (never together with other tool calls) when the context is getting full: " +
          "the conversation will continue in a fresh context containing only your summary, so the summary must carry everything needed to continue " +
          "(goals, decisions, key facts, state). Optionally list the remaining work.",
        inputSchema: JSON.stringify({
          type: "object",
          properties: {
            summary: {
              type: "string",
              pattern: "\\S",
              description: "Self-contained summary of the conversation so far; the only thing the fresh context will contain.",
            },
            remaining_work: {
              type: "string",
              description: "Optional description of the work still to be done.",
            },
          },
          required: ["summary"],
          additionalProperties: false,
        }),
      },
    ];
  }

  canHandle(name: string): boolean {
    return name === COMPACT_CONTEXT_TOOL_NAME;
  }

  async execute(_name: string, args: Record<string, unknown>): Promise<string> {
    const parsed = parseCompactContextArgs(args);
    if (!parsed.ok) throw new Error(parsed.error);
    return "compact_context is handled by the tool loop; nothing is executed here.";
  }
}
