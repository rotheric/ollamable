/**
 * tests/integration/capture-vocab-fixture.test.ts — AC-DEP-2 conformance
 * for scripts/capture-vocab-fixture.mjs.
 *
 * Drives the script's real capture/idempotency logic (`run()`) against a
 * mocked Ollama host and a mocked reference-tokenize function — no live
 * host or reference-tokenizer CLI needed to prove the script's own
 * behavior is correct. Separately, statically confirms the reference
 * tokenizer never appears in `server/`'s imports or in package.json's
 * `dependencies` (only as a devDependency of this script, if at all —
 * this script shells out to external CLIs rather than importing a
 * package, so today there is no such dependency at all).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync as fsReaddirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import {
  run,
  FIXTURE_SET,
  modelSlugFor,
  parseLlamaTokenizeIds,
  referenceTokenize,
} from "../../scripts/capture-vocab-fixture.mjs";

const REPO_ROOT = process.cwd();

function fakeShowResponse(tokens: string[], merges: string[]) {
  return new Response(
    JSON.stringify({
      model_info: {
        "tokenizer.ggml.model": "gpt2",
        "tokenizer.ggml.pre": "qwen2",
        "tokenizer.ggml.tokens": tokens,
        "tokenizer.ggml.merges": merges,
        "not.a.tokenizer.field": "must not be captured",
      },
    }),
    { status: 200 }
  );
}

describe("scripts/capture-vocab-fixture.mjs (AC-DEP-2)", () => {
  it("writes a gzip vocab fixture containing only tokenizer.ggml.* fields, and a golden fixture for every fixture-set string", async () => {
    const written: Record<string, string | Buffer> = {};
    const fakeFetch = async () => fakeShowResponse(["a", "b", "ab"], ["a b"]);
    const fakeReferenceTokenize = async (text: string) => [text.length]; // deterministic stand-in

    const result = await run({
      baseUrl: "http://fake",
      model: "qwen3:1.7b",
      fetchImpl: fakeFetch,
      referenceTokenizeImpl: fakeReferenceTokenize,
      fixturesDir: "/fake/fixtures",
      write: (p: string, content: string | Buffer) => {
        written[p] = content;
      },
      log: () => {},
    });

    const vocabJson = JSON.parse(gunzipSync(result.vocabGzip as Buffer).toString("utf-8"));
    expect(vocabJson.model_info["tokenizer.ggml.tokens"]).toEqual(["a", "b", "ab"]);
    expect(vocabJson.model_info["tokenizer.ggml.merges"]).toEqual(["a b"]);
    // Only tokenizer.ggml.* fields are captured — never an unrelated field.
    expect(vocabJson.model_info).not.toHaveProperty("not.a.tokenizer.field");

    const goldens = JSON.parse(result.goldensJson as string);
    expect(Object.keys(goldens).sort()).toEqual([...FIXTURE_SET].sort());
    for (const text of FIXTURE_SET) {
      expect(goldens[text]).toEqual([text.length]);
    }

    expect(written[result.vocabPath]).toBe(result.vocabGzip);
    expect(written[result.goldensPath]).toBe(result.goldensJson);
  });

  it("is idempotent: two runs against an unchanged model produce byte-identical output", async () => {
    const fakeFetch = async () => fakeShowResponse(["x", "y", "xy"], ["x y"]);
    const fakeReferenceTokenize = async (text: string) => Array.from(text).map((c) => c.charCodeAt(0));

    const run1 = await run({
      baseUrl: "http://fake",
      model: "qwen3:1.7b",
      fetchImpl: fakeFetch,
      referenceTokenizeImpl: fakeReferenceTokenize,
      fixturesDir: "/fake/fixtures",
      write: () => {},
      log: () => {},
    });
    const run2 = await run({
      baseUrl: "http://fake",
      model: "qwen3:1.7b",
      fetchImpl: fakeFetch,
      referenceTokenizeImpl: fakeReferenceTokenize,
      fixturesDir: "/fake/fixtures",
      write: () => {},
      log: () => {},
    });

    expect(Buffer.compare(run1.vocabGzip as Buffer, run2.vocabGzip as Buffer)).toBe(0);
    expect(run1.goldensJson).toBe(run2.goldensJson);
  });

  it("derives the output filename from the model name", async () => {
    expect(modelSlugFor("qwen3:1.7b")).toBe("qwen3-1.7b");
  });

  it("throws (does not silently write partial fixtures) when the live host has no verbose tokenizer info", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ model_info: {} }), { status: 200 });
    await expect(
      run({
        baseUrl: "http://fake",
        model: "qwen3:1.7b",
        fetchImpl: fakeFetch,
        fixturesDir: "/fake/fixtures",
        write: () => {
          throw new Error("must not write when the response is unusable");
        },
        log: () => {},
      })
    ).rejects.toThrow(/tokenizer\.ggml\.tokens/);
  });

  it("never imports a reference-tokenizer package under server/, and none appears in package.json dependencies (devDependencies is where AC-DEP-2 permits it)", () => {
    const serverFiles = fsReaddirSync(path.join(REPO_ROOT, "server")).filter((f) => f.endsWith(".ts"));
    for (const file of serverFiles) {
      const contents = readFileSync(path.join(REPO_ROOT, "server", file), "utf-8");
      expect(contents).not.toMatch(/from\s+["']@?(huggingface\/transformers|transformers|llama-tokenize|tiktoken|gpt-tokenizer)/i);
    }

    // AC-DEP-2's bar is scoped to `dependencies` and to imports under
    // server/ — NOT to devDependencies, which is exactly where a
    // reference tokenizer belongs (this script's own dev-only tooling
    // uses @huggingface/transformers as a devDependency; see
    // referenceTokenize's HF_TOKENIZER_ID branch).
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(name).not.toMatch(/transformers|llama-tokenize|tiktoken|gpt-tokenizer/i);
    }
    expect(Object.keys(pkg.devDependencies ?? {})).toContain("@huggingface/transformers");
  });
});

// ── S3-C3: parseLlamaTokenizeIds ──────────────────────────────────────

describe("parseLlamaTokenizeIds (S3-C3)", () => {
  it("parses llama.cpp's bracketed, comma-separated --ids output", () => {
    expect(parseLlamaTokenizeIds("[1, 2, 3]\n")).toEqual([1, 2, 3]);
  });

  it("parses a plain whitespace-separated fallback format", () => {
    expect(parseLlamaTokenizeIds("1 2 3\n")).toEqual([1, 2, 3]);
  });

  it("throws instead of silently returning NaN/null for the old buggy split(\\s+) parse of bracketed output", () => {
    // This is exactly the input that used to silently produce
    // [NaN, NaN, NaN] (written as [null, null, null] by JSON.stringify)
    // via `out.trim().split(/\s+/).map(Number)` — "[1," -> NaN, "2," ->
    // NaN, "3]" -> NaN. The fix must either parse it correctly (it does,
    // via JSON.parse) or throw; it must never return a NaN-containing
    // array.
    const ids = parseLlamaTokenizeIds("[1, 2, 3]");
    expect(ids.every(Number.isInteger)).toBe(true);
  });

  it("throws on output that cannot be parsed to a non-empty array of integers", () => {
    expect(() => parseLlamaTokenizeIds("not tokenizer output")).toThrow();
    expect(() => parseLlamaTokenizeIds("")).toThrow();
    expect(() => parseLlamaTokenizeIds("[1, notanumber, 3]")).toThrow();
  });
});

// ── S3-C4: referenceTokenize fails fast with no reference configured ──

describe("referenceTokenize (S3-C4)", () => {
  const savedGguf = process.env.LLAMA_GGUF_PATH;
  const savedHf = process.env.HF_TOKENIZER_ID;

  beforeEach(() => {
    delete process.env.LLAMA_GGUF_PATH;
    delete process.env.HF_TOKENIZER_ID;
  });

  afterEach(() => {
    if (savedGguf === undefined) delete process.env.LLAMA_GGUF_PATH;
    else process.env.LLAMA_GGUF_PATH = savedGguf;
    if (savedHf === undefined) delete process.env.HF_TOKENIZER_ID;
    else process.env.HF_TOKENIZER_ID = savedHf;
  });

  it("fails fast with a clear message instead of trying either tool with the Ollama model name", async () => {
    // Neither LLAMA_GGUF_PATH nor HF_TOKENIZER_ID is set: previously this
    // fell through to calling llama-tokenize with the Ollama model name
    // as a --model path, then AutoTokenizer.from_pretrained("qwen3:1.7b")
    // — neither of which is a valid argument to its tool, so both failed
    // opaquely. It must now reject immediately with a message that names
    // both env vars, before attempting either tool.
    await expect(referenceTokenize("hi", "qwen3:1.7b")).rejects.toThrow(/LLAMA_GGUF_PATH/);
    await expect(referenceTokenize("hi", "qwen3:1.7b")).rejects.toThrow(/HF_TOKENIZER_ID/);
  });
});
