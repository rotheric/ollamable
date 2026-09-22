#!/usr/bin/env node
/**
 * scripts/capture-vocab-fixture.mjs — captures the two committed tokenizer
 * fixtures (epic-token-view, story S3, AC-DEP-2) from a LIVE Ollama host:
 *
 *   - tests/fixtures/<model-slug>-vocab.json.gz — gzip bytes of
 *     `{ model_info: <the tokenizer.ggml.* fields, byte-identical to the
 *     live /show response> }` (Implementation Constraint 8's large-fixture
 *     policy — the `.gz` extension names the encoding rather than leaving
 *     a `.json`-named file holding gzip bytes).
 *   - tests/fixtures/<model-slug>-goldens.json — `{ [text]: tokenIds }`
 *     for the fixture-set strings, produced by a REFERENCE tokenizer
 *     (never this repo's own server/tokenizer.ts — AC-TOK-7 exists
 *     specifically to catch bugs in that implementation, so the golden
 *     values must come from an independent source).
 *
 * Usage:
 *   OLLAMA_URL=http://localhost:11434/api HF_TOKENIZER_ID=Qwen/Qwen3-1.7B \
 *     node scripts/capture-vocab-fixture.mjs [model]
 *
 * `[model]` defaults to "qwen3:1.7b". Requires a reachable Ollama host
 * with the model already pulled, and exactly one of these two env vars
 * pointing at a reference tokenizer (an Ollama model name like
 * "qwen3:1.7b" is valid for neither — it is not a filesystem path or a
 * Hugging Face repo id):
 *
 *   - `LLAMA_GGUF_PATH` — local path to the model's `.gguf` file, used
 *     with the `llama-tokenize` CLI (llama.cpp) on PATH.
 *   - `HF_TOKENIZER_ID` — a Hugging Face repo id (e.g. "Qwen/Qwen3-1.7B"),
 *     loaded IN-PROCESS via `@huggingface/transformers`'
 *     `AutoTokenizer.from_pretrained(id)`, which fetches and caches the
 *     repo's `tokenizer.json`/`tokenizer_config.json` under
 *     `node_modules/@huggingface/transformers/.cache/` on first use — no
 *     `python3` or separately-downloaded file required, so this path is
 *     reproducible from a clean checkout given only network access to
 *     huggingface.co. (An earlier revision shelled out to a `python3`
 *     one-liner instead; that required a local Python + `transformers`
 *     install this environment doesn't have, so it never actually ran
 *     here — the JS-native path is the one that does.)
 *
 * If neither is set, `referenceTokenize` fails fast with a clear message
 * rather than attempting either tool with an argument that cannot work
 * (S3-C4). `llama-tokenize` is an external CLI, never a dependency of
 * this repo; `@huggingface/transformers` IS a `devDependency` (AC-DEP-2
 * bars the reference tokenizer only from `dependencies` and from being
 * imported by anything under `server/` — devDependency + dev-only script
 * satisfies both). This script is dev-only tooling, run by hand when
 * re-capturing fixtures against a real host.
 *
 * Idempotent: running this twice against an unchanged model produces
 * byte-identical output for both files (the vocab fixture is a direct,
 * order-preserving snapshot of the response; the golden fixture's keys
 * are written in a fixed, sorted order).
 *
 * `run()` below takes its I/O (fetch, a reference-tokenize function, a
 * file writer) as parameters so tests/integration/capture-vocab-fixture.
 * test.ts can drive the real capture/idempotency logic against a mocked
 * host — this file's own module-level code only supplies the REAL I/O
 * and is skipped when imported (`isMain` guard) rather than executed.
 */

import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "tests", "fixtures");

/** The strings every conformance test exercises (glossary "fixture set"). */
export const FIXTURE_SET = [
  "Hello world",
  "strawberry",
  "Die Verkehrsinfrastruktur",
  "```\ncode\n```",
  "a\n\n\nb",
  "a|b",
];

export function modelSlugFor(model) {
  return model.replace(/[^a-z0-9.-]+/gi, "-");
}

/**
 * Core capture logic with injectable I/O. Returns the two file contents
 * it would write (or did write, if `write` is provided) so a test can
 * assert on them directly without touching the filesystem.
 */
export async function run({
  baseUrl,
  model,
  fetchImpl = fetch,
  referenceTokenizeImpl = referenceTokenize,
  fixturesDir = FIXTURES_DIR,
  write = writeFileSync,
  log = console.log,
}) {
  log(`[capture-vocab-fixture] OLLAMA_URL=${baseUrl} model=${model}`);

  const showResponse = await fetchImpl(`${baseUrl}/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, verbose: true }),
  }).catch((err) => {
    throw new Error(`Could not reach ${baseUrl}/show — is Ollama running and is "${model}" pulled? (${err.message})`);
  });

  if (!showResponse.ok) {
    throw new Error(`POST ${baseUrl}/show returned ${showResponse.status}`);
  }

  const body = await showResponse.json();
  const modelInfo = body.model_info;
  if (!modelInfo || !Array.isArray(modelInfo["tokenizer.ggml.tokens"])) {
    throw new Error(
      `Response for "${model}" has no model_info["tokenizer.ggml.tokens"] — is this an Ollama build that supports verbose /show?`
    );
  }

  // Byte-identical snapshot of every tokenizer.ggml.* scalar/array field,
  // never a hand-picked subset — re-running against an unchanged model
  // must reproduce the exact same bytes.
  const tokenizerFields = Object.fromEntries(
    Object.entries(modelInfo).filter(([key]) => key.startsWith("tokenizer.ggml."))
  );

  const modelSlug = modelSlugFor(model);
  const vocabPath = path.join(fixturesDir, `${modelSlug}-vocab.json.gz`);
  const vocabJson = JSON.stringify({ model_info: tokenizerFields });
  const vocabGzip = gzipSync(Buffer.from(vocabJson, "utf-8"));
  write(vocabPath, vocabGzip);
  log(`[capture-vocab-fixture] wrote ${path.relative(REPO_ROOT, vocabPath)} (gzip, ${vocabJson.length} bytes uncompressed)`);

  const goldens = {};
  for (const text of FIXTURE_SET) {
    goldens[text] = await referenceTokenizeImpl(text, model);
  }
  // Sorted key order (not insertion order) so two runs produce
  // byte-identical JSON even if FIXTURE_SET's own order ever changes.
  const sortedGoldens = Object.fromEntries(Object.keys(goldens).sort().map((k) => [k, goldens[k]]));
  const goldensJson = JSON.stringify(sortedGoldens, null, 2) + "\n";

  const goldensPath = path.join(fixturesDir, `${modelSlug}-goldens.json`);
  write(goldensPath, goldensJson);
  log(`[capture-vocab-fixture] wrote ${path.relative(REPO_ROOT, goldensPath)}`);

  return { vocabPath, vocabGzip, goldensPath, goldensJson };
}

/**
 * Parses llama.cpp's `llama-tokenize --ids` stdout into an array of
 * token ids (S3-C3). Current llama.cpp builds print a bracketed,
 * comma-separated list (e.g. `[1, 2, 3]`); this used to be parsed as
 * whitespace-separated numbers (`"[1,".split(...) -> NaN` for every
 * element), which silently wrote `null`s into the golden fixture with no
 * error at all. `JSON.parse` handles the bracketed form directly; the
 * fallback strips a leading `[`/trailing `]` and splits on
 * whitespace-or-comma for formats `JSON.parse` can't parse as-is. Either
 * way, every element is checked with `Number.isInteger` before this
 * returns — the exact stdout format may still vary by llama.cpp version,
 * so a shape this function doesn't recognize must throw rather than
 * silently produce a `NaN`/`null` that ends up in a committed fixture.
 */
export function parseLlamaTokenizeIds(out) {
  const trimmed = out.trim();
  let ids;
  try {
    ids = JSON.parse(trimmed);
  } catch {
    ids = trimmed
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number);
  }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(n))) {
    throw new Error(`llama-tokenize output did not parse to a non-empty array of integer ids: ${JSON.stringify(out)}`);
  }
  return ids;
}

/**
 * Reference tokenIds for `text` under `model`, from an INDEPENDENT
 * tokenizer implementation — never this repo's server/tokenizer.ts.
 * Uses `llama-tokenize` (llama.cpp) when `LLAMA_GGUF_PATH` is set, or
 * `@huggingface/transformers`' `AutoTokenizer.from_pretrained` (in-process,
 * no subprocess) when `HF_TOKENIZER_ID` is set. Neither is imported by
 * anything under `server/`, and neither is a `dependencies` entry of this
 * repo (the HF package is a `devDependency`, used only here).
 *
 * Fails fast (S3-C4) when neither env var is set, rather than trying
 * both tools with the Ollama `model` name — which is a valid argument
 * to neither `llama-tokenize --model` (wants a local `.gguf` path) nor
 * `AutoTokenizer.from_pretrained` (wants a Hugging Face repo id) — and
 * only discovering that from two opaque tool failures.
 */
export async function referenceTokenize(text, model) {
  const ggufPath = process.env.LLAMA_GGUF_PATH;
  const hfTokenizerId = process.env.HF_TOKENIZER_ID;

  if (!ggufPath && !hfTokenizerId) {
    throw new Error(
      `No reference tokenizer configured for model "${model}". Set LLAMA_GGUF_PATH to a local .gguf file ` +
        `to tokenize with llama-tokenize, or HF_TOKENIZER_ID to a Hugging Face repo id (e.g. "Qwen/Qwen3-1.7B") ` +
        `to tokenize with transformers — the Ollama model name itself is a valid argument to neither tool.`
    );
  }

  if (ggufPath) {
    const out = execFileSync("llama-tokenize", ["--model", ggufPath, "--prompt", text, "--ids"], {
      encoding: "utf-8",
    });
    return parseLlamaTokenizeIds(out);
  }

  const tokenizer = await loadReferenceTokenizer(hfTokenizerId);
  const ids = tokenizer.encode(text, { add_special_tokens: false });
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(n))) {
    throw new Error(
      `AutoTokenizer.encode did not return a non-empty array of integer ids for HF_TOKENIZER_ID="${hfTokenizerId}": ${JSON.stringify(ids)}`
    );
  }
  return ids;
}

// Memoized across calls within one process: `run()` calls referenceTokenize
// once per fixture-set string, and re-constructing an AutoTokenizer per
// call (re-reading its cached files, re-parsing the merge table) is wasted
// work once the same `hfTokenizerId` has already been loaded once.
let cachedTokenizer;
let cachedTokenizerId;

async function loadReferenceTokenizer(hfTokenizerId) {
  if (cachedTokenizer && cachedTokenizerId === hfTokenizerId) return cachedTokenizer;
  const { AutoTokenizer } = await import("@huggingface/transformers");
  cachedTokenizer = await AutoTokenizer.from_pretrained(hfTokenizerId);
  cachedTokenizerId = hfTokenizerId;
  return cachedTokenizer;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const baseUrl = process.env.OLLAMA_URL ?? "http://localhost:11434/api";
  const model = process.argv[2] ?? "qwen3:1.7b";
  run({ baseUrl, model }).catch((err) => {
    console.error(`[capture-vocab-fixture] ${err.message}`);
    process.exit(1);
  });
}
