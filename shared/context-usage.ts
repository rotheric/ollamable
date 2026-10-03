import type { FormatStep } from "./openai-format.js";

/**
 * Arithmetic shared by the context meter (frontend) and the model-facing usage
 * note (server), so the two can never disagree about the percentage.
 */

/** `used` as a rounded integer percentage of `window`; 0 when the window is not a positive number. */
export function contextPercent(used: number, window: number): number {
  if (!(window > 0) || !Number.isFinite(used)) return 0;
  return Math.round((used / window) * 100);
}

/**
 * Wire positions for the model-facing usage note, as researched in
 * docs/research/compaction-placement.md (candidate names match that document).
 *
 * Collate semantics (the document's Decision defines them): `trailing-user` appends the note as a
 * final paragraph to the last message when that is user-role, otherwise adds a separate user
 * message, so no two user messages become adjacent on the wire (safe for strict
 * OpenAI-compatible servers, which were not probed).
 */
export const NOTE_PLACEMENTS = ["trailing-system", "first-system-append", "trailing-user"] as const;
export type NotePlacement = (typeof NOTE_PLACEMENTS)[number];

/**
 * Wire role of the compaction summary when it is seeded into a fork's context. A `user` summary
 * must be collated with the user's next message so no two user messages are adjacent.
 */
export const SUMMARY_PLACEMENTS = ["system", "user"] as const;
export type SummaryPlacement = (typeof SUMMARY_PLACEMENTS)[number];

/** Per-family override; an absent field means "use the default". */
export interface ContextPlacementException {
  note?: NotePlacement;
  summary?: SummaryPlacement;
}

export interface ContextPlacement {
  /** Default note placement for every family without an exception (including OpenAI-compatible models). */
  note: NotePlacement;
  /** Default summary placement for every family without an exception. */
  summary: SummaryPlacement;
  /** Exceptions keyed by the model family string (`/models/show` `details.family`). */
  exceptions: Readonly<Record<string, ContextPlacementException>>;
}

/**
 * The `Decision` table of docs/research/compaction-placement.md as data (pure data; the
 * transform that consumes it is `applyContextPlacement`). A unit test keeps the two equal.
 */
export const CONTEXT_PLACEMENT: ContextPlacement = {
  note: "trailing-user",
  summary: "user",
  exceptions: {},
};

// ── Model-facing usage note and placement transform ──────────────────────────────────────────

/** Provenance of a context window (structural twin of `ContextWindowSource` on both sides of the boundary). */
export const CONTEXT_WINDOW_SOURCES = ["runtime", "modelfile", "estimated", "assumed"] as const;
export type ContextNoteSource = (typeof CONTEXT_WINDOW_SOURCES)[number];

/** The tool the note nudges the model towards; the literal the note must always contain. */
export const COMPACT_CONTEXT_TOOL_NAME = "compact_context";

/** The real window is only known to the app when the source is not `assumed`. */
export interface ContextNoteInput {
  /** Tokens in the model's context after its last invocation; absent when nothing was reported yet. */
  usedTokens?: number;
  windowTokens: number;
  source: ContextNoteSource;
}

/** Fixed `en-US` grouping, independent of the process locale (the note is model-facing text). */
const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, useGrouping: true });

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(Math.round(value));
}

/**
 * The text appended to the model's context while `compact_context` is enabled. It never states a
 * number the app does not know: no `usedTokens` gives a number-free sentence, an `assumed` window
 * gives the used tokens only, and an `estimated` window marks window and percentage as approximate.
 * The wording is written to read well as the final paragraph of the user's last message, because
 * `applyContextPlacement` collates it there.
 */
export function buildContextUsageNote({ usedTokens, windowTokens, source }: ContextNoteInput): string {
  const tool = COMPACT_CONTEXT_TOOL_NAME;
  const advice = `If the conversation is getting long, you can call the ${tool} tool to summarize it and continue in a fresh context.`;
  const lead = "(Automatic note from the app, not written by the user.)";
  const known = typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
  if (!known) return `${lead} ${advice}`;

  const used = formatCount(usedTokens);
  const percent = contextPercent(usedTokens, windowTokens);
  // Without a usable window (or a percentage that overflows) only the used tokens are stated.
  const windowUsable = Math.round(windowTokens) >= 1 && Number.isFinite(windowTokens) && Number.isFinite(percent);
  if (source === "assumed" || !windowUsable) {
    return `${lead} The context currently holds ${used} tokens. ${advice}`;
  }
  const window = formatCount(windowTokens);
  if (source === "estimated") {
    return `${lead} The context currently holds ${used} tokens, approximately ${percent}% of an estimated window of approximately ${window} tokens. ${advice}`;
  }
  return `${lead} The context currently holds ${used} of ${window} tokens (${percent}%). ${advice}`;
}

/** Minimal shape carried by a step (both `ConversationStep` types satisfy it). */
interface UsageCarrier {
  kind: string;
  usage?: { inputTokens?: number; outputTokens?: number; stopReason?: string };
}

/**
 * `inputTokens + outputTokens` of the LATEST response's usage, i.e. the size of the model's whole
 * context after its latest invocation. Scans backward: the first step with numeric usage wins, but
 * an `assistant` step without numeric usage, or any step carrying a `usage` object without numeric
 * token counts (e.g. `{ stopReason }` only, which the server attaches to the first step of a
 * response that reported no usage, a `tool_call` for a tool-only response), met first means the
 * latest response reported none, so the result is `undefined` even when an older response reported
 * usage (a stale figure would understate the context). Steps without a `usage` object (tool_result,
 * user, meta, tool_call, reasoning, compaction, system) are skipped.
 *
 * Completed responses: the server attaches a (possibly empty) `usage` object to every response
 * whose stream completed with at least one step, so one that reported nothing is a boundary here.
 * Residual: an interrupted response (no usage object) or a completed response that produced no
 * steps at all (nothing is stored) can leave an older figure in place.
 */
export function lastUsedTokens(steps: ReadonlyArray<UsageCarrier>): number | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const { kind, usage } = steps[i];
    if (usage && (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number")) {
      return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    }
    // A usage object without token counts marks a response that reported none.
    if (kind === "assistant" || usage) return undefined;
  }
  return undefined;
}

/**
 * Structural step the transform works on (`ConversationStep` on both sides of the boundary
 * satisfies it). `kind` stays a plain string so `compaction` steps need no type addition here.
 */
export interface PlacementStep extends FormatStep, UsageCarrier {
  metaEvent?: { kind: string };
  id: string;
  title: string;
  createdAt: string;
}

export interface ApplyContextPlacementOptions {
  /** Text to place per the family's note placement; no note, no insertion. */
  note?: string;
  /** Model family string (`/models/show` `details.family`) used to look up placement exceptions. */
  family?: string;
  /** Placement data; defaults to `CONTEXT_PLACEMENT`. Injectable so exception rows can be exercised. */
  placement?: ContextPlacement;
}

/**
 * The single rule for "the usage note exists": `compact_context` is among the request's enabled
 * tools. Used by the server, the request preview and the token view so they cannot disagree.
 */
export function isCompactContextEnabled(tools: ReadonlyArray<{ name: string }> | undefined): boolean {
  return (tools ?? []).some((tool) => tool.name === COMPACT_CONTEXT_TOOL_NAME);
}

/**
 * Steps the wire formatters emit a message for; the rest never take part in collation. Mirrors
 * `toOllamaMessages` / `toOpenAIMessages` exactly: meta and reasoning steps and empty system steps
 * are dropped, and a tool_call / tool_result step without its payload is dropped too.
 */
function isWireStep(step: FormatStep): boolean {
  switch (step.kind) {
    case "meta":
    case "reasoning":
      return false;
    case "system":
      return step.content.trim().length > 0;
    case "tool_call":
      return !!step.toolCall;
    case "tool_result":
      return !!step.toolResult;
    default:
      return true;
  }
}

function appendParagraph(content: string, paragraph: string): string {
  return content.trim().length === 0 ? paragraph : `${content}\n\n${paragraph}`;
}

const SYNTHETIC_NOTE_STEP = {
  id: "context-usage-note",
  title: "Context usage note",
  createdAt: "1970-01-01T00:00:00.000Z",
} as const;

/**
 * Maps the conversation's steps to what the model should receive, returning a NEW array and never
 * mutating `steps` (a modified step is a clone). Always called before the wire formatters, also
 * without a note, because a `compaction` step has no wire form of its own:
 *
 * - a `compaction` step becomes a user-role step per the summary placement; a user step (or another
 *   compaction step) that immediately follows it is collated onto it, so no two user messages are
 *   adjacent;
 * - the note is appended, as a blank-line separated paragraph, to the last wire step when that is
 *   user-role, otherwise it becomes a separate user step at the end (collate semantics of
 *   docs/research/compaction-placement.md).
 *
 * Only the placements `CONTEXT_PLACEMENT` can yield are implemented (`trailing-user` for the note,
 * `user` for the summary); data asking for any other placement throws rather than degrading.
 */
export function applyContextPlacement<T extends PlacementStep>(
  steps: ReadonlyArray<T>,
  { note, family, placement = CONTEXT_PLACEMENT }: ApplyContextPlacementOptions = {}
): T[] {
  const exception = family === undefined ? undefined : placement.exceptions[family];
  const summaryPlacement = exception?.summary ?? placement.summary;
  const notePlacement = exception?.note ?? placement.note;
  if (summaryPlacement !== "user") throw new Error(`Unsupported summary placement: ${summaryPlacement}`);
  if (notePlacement !== "trailing-user") throw new Error(`Unsupported note placement: ${notePlacement}`);

  const out: T[] = [];
  // Index in `out` of the last wire step, and whether it came from a compaction step.
  let lastWire = -1;
  let lastWireIsSummary = false;

  for (const step of steps) {
    const isSummary = step.kind === "compaction";
    if (!isWireStep(step) && !isSummary) {
      out.push(step);
      continue;
    }
    if (lastWireIsSummary && (isSummary || step.kind === "user")) {
      out[lastWire] = { ...out[lastWire], content: appendParagraph(out[lastWire].content, step.content) };
      continue;
    }
    out.push(isSummary ? { ...step, kind: "user" } : step);
    lastWire = out.length - 1;
    lastWireIsSummary = isSummary;
  }

  if (note !== undefined) {
    if (lastWire >= 0 && out[lastWire].kind === "user") {
      out[lastWire] = { ...out[lastWire], content: appendParagraph(out[lastWire].content, note) };
    } else {
      out.push({ ...SYNTHETIC_NOTE_STEP, kind: "user", content: note } as unknown as T);
    }
  }
  return out;
}

/**
 * Drops what the model must never see after a compaction: the app's harness step (`meta` /
 * `compaction`) and every `compact_context` call that was honoured, i.e. has no `tool_result`
 * paired with it (same call id; id-less calls pair as described below). A rejected call keeps its error
 * `tool_result` and stays, so the model still learns why nothing was compacted.
 */
function omitCompactionArtifacts<T extends PlacementStep>(steps: ReadonlyArray<T>): T[] {
  // Calls answered by a result. Id-bearing calls pair by id; id-less ones (Ollama) pair each result
  // with the nearest preceding unpaired call of the same name, so a later turn's result can never
  // "answer" an honoured compaction call from an earlier turn.
  const answered = new Set<number>();
  const resultIds = new Set<string>();
  const unpaired = new Map<string, number[]>();
  steps.forEach((step, index) => {
    if (step.kind === "tool_call" && step.toolCall && step.toolCall.id === undefined) {
      const stack = unpaired.get(step.toolCall.name) ?? [];
      stack.push(index);
      unpaired.set(step.toolCall.name, stack);
    } else if (step.kind === "tool_result" && step.toolResult) {
      if (step.toolResult.id !== undefined) resultIds.add(step.toolResult.id);
      else {
        const callIndex = unpaired.get(step.toolResult.name)?.pop();
        if (callIndex !== undefined) answered.add(callIndex);
      }
    }
  });
  return steps.filter((step, index) => {
    if (step.kind === "meta" && step.metaEvent?.kind === "compaction") return false;
    if (step.kind === "tool_call" && step.toolCall?.name === COMPACT_CONTEXT_TOOL_NAME) {
      return step.toolCall.id !== undefined ? resultIds.has(step.toolCall.id) : answered.has(index);
    }
    return true;
  });
}

export interface PlaceStepsInput {
  /** `compact_context` is among the request's enabled tools; the note exists only then. */
  compactEnabled: boolean;
  /** Used tokens after the previous invocation (`lastUsedTokens` of the steps before the target), if known. */
  usedTokens: number | undefined;
  /** The window the client resolved; absent means the server was told nothing (treated as assumed). */
  window?: { tokens: number; source: ContextNoteSource };
  family?: string;
}

/**
 * The single recipe every place that shows or sends "what the model receives" uses (tool loop,
 * request JSON preview, token view), so the note text and index cannot drift between them.
 */
export function placeStepsForModel<T extends PlacementStep>(steps: ReadonlyArray<T>, input: PlaceStepsInput): T[] {
  steps = omitCompactionArtifacts(steps);
  const note = input.compactEnabled
    ? buildContextUsageNote({
        usedTokens: input.usedTokens,
        windowTokens: input.window?.tokens ?? 0,
        source: input.window?.source ?? "assumed",
      })
    : undefined;
  return applyContextPlacement(steps, { note, family: input.family });
}
