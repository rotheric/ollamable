import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_PLACEMENT,
  NOTE_PLACEMENTS,
  SUMMARY_PLACEMENTS,
  type ContextPlacement,
  type NotePlacement,
  type SummaryPlacement,
} from "../../shared/context-usage";

const DOC_PATH = resolve(__dirname, "../../docs/research/compaction-placement.md");
const doc = readFileSync(DOC_PATH, "utf8");

function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

const cell = (raw: string): string => raw.trim().replace(/^`|`$/g, "");

/**
 * Parses the Decision table: header `Family | Note placement | Summary placement`, one `default`
 * row and zero or more family rows (`-` means "no override").
 */
function parseDecisionTable(markdown: string): ContextPlacement {
  const rows = section(markdown, "Decision")
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map(cell));
  const [header, , ...body] = rows;
  if (!header || header.join("|") !== "Family|Note placement|Summary placement") {
    throw new Error("Decision table header not found");
  }
  const defaults = body.filter(([family]) => family === "default");
  if (defaults.length !== 1) throw new Error("Decision table needs exactly one default row");
  const exceptions: Record<string, { note?: NotePlacement; summary?: SummaryPlacement }> = {};
  for (const [family, note, summary] of body) {
    if (family === "default") continue;
    exceptions[family] = {
      ...(note !== "-" ? { note: note as NotePlacement } : {}),
      ...(summary !== "-" ? { summary: summary as SummaryPlacement } : {}),
    };
  }
  return { note: defaults[0][1] as NotePlacement, summary: defaults[0][2] as SummaryPlacement, exceptions };
}

describe("compaction placement research document (AC-RES-1..4)", () => {
  it("has Method, Candidates, Findings and Decision sections", () => {
    const headings = doc.split("\n").filter((l) => /^## /.test(l));
    expect(headings).toEqual(["## Method", "## Candidates", "## Findings", "## Decision"]);
  });

  it("Method names the Ollama version and states that prompt_eval_count is not a cache instrument", () => {
    const method = section(doc, "Method");
    expect(method).toMatch(/\b0\.\d+\.\d+\b/);
    expect(method).toContain("prompt_eval_duration");
    expect(method).toContain("OLLAMA_DEBUG");
    expect(method).toMatch(/`prompt_eval_count` is not a cache instrument/);
  });

  it("Candidates lists every note and summary candidate, including the bare fork shape", () => {
    const candidates = section(doc, "Candidates");
    for (const id of [...NOTE_PLACEMENTS, ...SUMMARY_PLACEMENTS, "bare-fork"]) {
      expect(candidates).toContain(`\`${id}\``);
    }
  });

  it("Findings has a row per note candidate for at least three families including qwen3, and records the overflow count", () => {
    const findings = section(doc, "Findings");
    const rowFamilies = new Set<string>();
    let family = "";
    for (const line of findings.split("\n")) {
      const m = /^\|\s*([a-z0-9]+)(?: \(base \d+\))?\s*\|\s*`([a-z-]+)`/.exec(line);
      if (!m) continue;
      family = m[1];
      if ((NOTE_PLACEMENTS as readonly string[]).includes(m[2])) rowFamilies.add(`${family}/${m[2]}`);
    }
    const families = new Set([...rowFamilies].map((k) => k.split("/")[0]));
    expect(families.size).toBeGreaterThanOrEqual(3);
    expect(families.has("qwen3")).toBe(true);
    for (const f of families) {
      for (const p of NOTE_PLACEMENTS) expect(rowFamilies.has(`${f}/${p}`)).toBe(true);
    }
    expect(findings).toMatch(/Reported `prompt_eval_count`/);
    expect(findings).toMatch(/2047/);
  });

  it("Findings has a summary table with system and user rows and a bare-fork column for at least three families including qwen3", () => {
    const findings = section(doc, "Findings");
    const start = findings.indexOf("### Summary placement");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = findings.slice(start + 1);
    const next = rest.indexOf("\n### ");
    const summary = findings.slice(start, next < 0 ? undefined : start + 1 + next);
    const rows = summary
      .split("\n")
      .filter((l) => l.trim().startsWith("|"))
      .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map(cell));
    expect(rows[0]?.[1]).toBe("Candidate");
    expect(rows[0]?.[3]).toMatch(/bare/);
    const perFamily = new Map<string, Map<string, string>>();
    let family = "";
    for (const r of rows.slice(2)) {
      if (r[0]) family = r[0];
      const counts = perFamily.get(family) ?? new Map<string, string>();
      counts.set(r[1], r[3]);
      perFamily.set(family, counts);
    }
    expect(perFamily.size).toBeGreaterThanOrEqual(3);
    expect(perFamily.has("qwen3")).toBe(true);
    for (const [, byRole] of perFamily) {
      for (const role of SUMMARY_PLACEMENTS) {
        // "with turn / bare": two token counts, the second being the bare-fork column
        expect(byRole.get(role)).toMatch(/^\d+ \/ \d+$/);
      }
    }
  });

  it("Decision states the meaning of the meter error band", () => {
    expect(section(doc, "Decision")).toMatch(/`error` band/);
  });
});

describe("exported placement data equals the Decision table (AC-RES-4)", () => {
  it("parsed Decision table deep-equals CONTEXT_PLACEMENT", () => {
    expect(parseDecisionTable(doc)).toEqual(CONTEXT_PLACEMENT);
  });

  it("every placement value, in the document and in the data, is a member of the declared enum", () => {
    const parsed = parseDecisionTable(doc);
    for (const p of [parsed, CONTEXT_PLACEMENT]) {
      expect(NOTE_PLACEMENTS).toContain(p.note);
      expect(SUMMARY_PLACEMENTS).toContain(p.summary);
      for (const [family, ex] of Object.entries(p.exceptions)) {
        expect(family).not.toBe("");
        if (ex.note !== undefined) expect(NOTE_PLACEMENTS).toContain(ex.note);
        if (ex.summary !== undefined) expect(SUMMARY_PLACEMENTS).toContain(ex.summary);
      }
    }
  });

  it("detects drift: mutating a document cell or adding an exception row breaks equality", () => {
    const changedDefault = doc.replace(/\| `default` \| `trailing-user` \|/, "| `default` | `trailing-system` |");
    expect(changedDefault).not.toBe(doc);
    expect(parseDecisionTable(changedDefault)).not.toEqual(CONTEXT_PLACEMENT);

    const withException = doc.replace(
      /(\| `default` \| `trailing-user` \| `user` \|\n)/,
      "$1| `llama` | `trailing-system` | - |\n"
    );
    expect(withException).not.toBe(doc);
    expect(parseDecisionTable(withException)).toEqual({
      ...CONTEXT_PLACEMENT,
      exceptions: { llama: { note: "trailing-system" } },
    });
    expect(parseDecisionTable(withException)).not.toEqual(CONTEXT_PLACEMENT);
  });
});
