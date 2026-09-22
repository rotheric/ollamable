/**
 * server/tokenizer.ts — byte-level BPE tokenizer sourced from Ollama's
 * `POST /show` (verbose) response (epic-token-view, story S3).
 *
 * Owns (per architecture.md's module map): the vocab/merge table cache
 * keyed by `(baseUrl, model)`, the qwen2-style pre-tokenizer split, the
 * GPT-2 byte<->unicode alphabet, BPE merge application by rank, and
 * special-token matching ahead of the pre-tokenizer split.
 *
 * AC-DEP-1: the ONLY data source for vocab/merges is the live
 * `POST {baseUrl}/show` response body — never a bundled file or npm
 * package. Nothing under `server/` imports a reference tokenizer.
 */

// ── Errors ──────────────────────────────────────────────────────────

/**
 * Thrown when a model's vocabulary cannot be used: an unreachable /show
 * call, a response missing the expected model_info fields, or a
 * `tokenizer.ggml.pre` value this module does not implement. Mapped by
 * server/ws-handler.ts to `tokenize.error{reason: "vocab_unavailable"}`
 * (AC-ERR-2).
 */
export class VocabUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VocabUnavailableError";
  }
}

/** The only `tokenizer.ggml.pre` value this module implements. */
const SUPPORTED_PRE = "qwen2";

// ── GPT-2 byte<->unicode alphabet ────────────────────────────────────
//
// Every raw byte (0-255) maps bijectively to a single printable unicode
// character, so byte-level BPE can operate on ordinary JS strings. This
// is the standard scheme from OpenAI's GPT-2 `bytes_to_unicode()` —
// printable Latin-1 bytes map to themselves; the remaining (mostly
// control) bytes map to codepoints starting at U+0100.

function buildByteToUnicode(): string[] {
  const bytes: number[] = [];
  for (let b = "!".charCodeAt(0); b <= "~".charCodeAt(0); b++) bytes.push(b);
  for (let b = "¡".charCodeAt(0); b <= "¬".charCodeAt(0); b++) bytes.push(b);
  for (let b = "®".charCodeAt(0); b <= "ÿ".charCodeAt(0); b++) bytes.push(b);

  const present = new Set(bytes);
  const table = new Array<number>(256);
  for (const b of bytes) table[b] = b;

  let extra = 0;
  for (let b = 0; b < 256; b++) {
    if (!present.has(b)) {
      table[b] = 256 + extra;
      extra++;
    }
  }

  return table.map((codePoint) => String.fromCharCode(codePoint));
}

/** `BYTE_TO_UNICODE[byteValue]` — the byte-alphabet character for a raw byte. */
const BYTE_TO_UNICODE = buildByteToUnicode();

/** Reverse of `BYTE_TO_UNICODE`: byte-alphabet character -> raw byte value. */
const UNICODE_TO_BYTE = new Map<string, number>(
  BYTE_TO_UNICODE.map((ch, byteValue) => [ch, byteValue])
);

/** Maps raw UTF-8 bytes to their byte-alphabet string, one char per byte. */
function byteEncode(text: string): string[] {
  const bytes = new TextEncoder().encode(text);
  const out = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = BYTE_TO_UNICODE[bytes[i]];
  }
  return out;
}

/** Maps a byte-alphabet vocab string back to its raw bytes. */
function byteDecodeToBytes(vocabEntry: string): Uint8Array {
  const out = new Uint8Array(vocabEntry.length);
  for (let i = 0; i < vocabEntry.length; i++) {
    const byteValue = UNICODE_TO_BYTE.get(vocabEntry[i]);
    if (byteValue === undefined) {
      throw new Error(`byte-decode: character not in the byte alphabet: ${JSON.stringify(vocabEntry[i])}`);
    }
    out[i] = byteValue;
  }
  return out;
}

// ── qwen2 pre-tokenizer split ─────────────────────────────────────────
//
// The Qwen2/Qwen2.5/Qwen3 `tokenizer.json` pre-tokenizer, llama.cpp's
// `LLAMA_VOCAB_PRE_TYPE_QWEN2` `regex_exprs`, and Ollama's own `qwen3`
// model definition all use this exact pattern. It is NOT the same regex
// OpenAI uses for cl100k_base (GPT-4) — that was an earlier, incorrect
// assumption in this comment. The one substantive difference is the
// numeric rule: cl100k_base caps digit runs at 3 (`\p{N}{1,3}`); Qwen's
// pattern is a bare `\p{N}`, so every digit is its own pre-token (this is
// why Qwen-family models tokenize numbers digit-by-digit, e.g. "2024" ->
// "2","0","2","4" rather than "202","4"). The contraction group is
// spelled out case-by-case (`'[sS]|'[tT]|...`) rather than a single `i`
// flag on the whole pattern, because scoping case-insensitivity to just
// the contraction group is what the reference `(?i:...)` group does —
// applying `i` (with `u`) to the whole pattern lets JavaScript
// simple-case-fold non-letters whose fold IS a letter (e.g. the
// combining mark U+0345) into `\p{L}`, silently changing where
// `[^\r\n\p{L}\p{N}]?\p{L}+` draws its boundary. `\p{White_Space}` /
// `\P{White_Space}` (not `\s`/`\S`) match the reference tokenizers'
// Unicode `White_Space` property exactly — JS's `\s` diverges from it in
// both directions (includes U+FEFF, excludes U+0085 NEL). `m` is dropped
// too: the pattern has no anchors, so it was dead weight on the original
// flags. The vocab/golden fixtures are constructed against this exact
// pattern, so the conformance suite is internally consistent regardless.
const QWEN2_SPLIT_REGEX =
  /'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\p{White_Space}\p{L}\p{N}]+[\r\n]*|\p{White_Space}*[\r\n]+|\p{White_Space}+(?!\P{White_Space})|\p{White_Space}+/gu;

function preTokenize(text: string): string[] {
  if (text.length === 0) return [];
  return text.match(QWEN2_SPLIT_REGEX) ?? [];
}

/** Test-only: exposes the pre-tokenizer split directly, since `tokenize`'s
 *  BPE merge step re-splits every pre-token into byte-level symbols
 *  (unless a merge rule happens to apply), which makes pre-token
 *  boundaries themselves unobservable through the public API alone. */
export function __preTokenizeForTests(text: string): string[] {
  return preTokenize(text);
}

// ── BPE merge ───────────────────────────────────────────────────────

/** Separator for merge-pair map keys. Never occurs in the byte alphabet
 *  (every byte-alphabet char is >= U+0021), so "a\u0000b" always uniquely
 *  identifies the pair (a, b). */
const PAIR_SEP = "\u0000";

function getPairs(word: string[]): Map<string, [string, string]> {
  const pairs = new Map<string, [string, string]>();
  for (let i = 0; i < word.length - 1; i++) {
    pairs.set(word[i] + PAIR_SEP + word[i + 1], [word[i], word[i + 1]]);
  }
  return pairs;
}

/**
 * Standard BPE merge loop (mirrors OpenAI's GPT-2 `bpe()`): repeatedly
 * merge the lowest-rank adjacent pair present in the current word until no
 * ranked pair remains. `mergeRank` keys are `"a\u0000b"` -> rank (lower =
 * higher priority, matching merges.txt line order).
 */
export function bpeMerge(token: string[], mergeRank: Map<string, number>): string[] {
  let word = token;
  let pairs = getPairs(word);
  if (pairs.size === 0) return word;

  while (true) {
    let bestKey: string | null = null;
    let bestRank = Infinity;
    for (const key of pairs.keys()) {
      const rank = mergeRank.get(key);
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        bestKey = key;
      }
    }
    if (bestKey === null) break;

    const [first, second] = pairs.get(bestKey)!;
    const newWord: string[] = [];
    let i = 0;
    while (i < word.length) {
      const j = word.indexOf(first, i);
      if (j === -1) {
        newWord.push(...word.slice(i));
        break;
      }
      newWord.push(...word.slice(i, j));
      i = j;
      if (word[i] === first && i < word.length - 1 && word[i + 1] === second) {
        newWord.push(first + second);
        i += 2;
      } else {
        newWord.push(word[i]);
        i += 1;
      }
    }
    word = newWord;
    if (word.length === 1) break;
    pairs = getPairs(word);
  }
  return word;
}

// ── Vocab table ───────────────────────────────────────────────────────

export interface VocabTable {
  /** vocab.ggml.tokens, index = token id. Regular entries are byte-alphabet
   *  strings; special-token entries are literal text (see `specialTokens`). */
  tokens: string[];
  tokenToId: Map<string, number>;
  mergeRank: Map<string, number>;
  /** tokenizer.ggml.pre, kept for diagnostics. Always "qwen2" once loaded —
   *  loadVocab fails closed on any other value. */
  pre: string;
  /** Literal (non-byte-mapped) special tokens, e.g. "<|im_start|>". */
  specialTokens: string[];
  specialTokenSet: Set<string>;
}

interface ShowVerboseResponse {
  model_info?: Record<string, unknown>;
}

/** Fallback special-token detection when `tokenizer.ggml.token_type` is
 *  absent from the `/show` response: any vocab entry shaped like
 *  `<|...|>` is treated as a special token, matched verbatim ahead of
 *  the pre-tokenizer split rather than run through byte-level BPE. This
 *  catches OpenAI-style control tokens (`<|im_start|>`, `<|im_end|>`)
 *  but NOT Qwen3's own control vocabulary (`<think>`, `</think>`,
 *  `<tool_call>`, etc.), which is why `token_type` is preferred whenever
 *  the response carries it (S3-C2). */
const SPECIAL_TOKEN_PATTERN = /^<\|[^|]+\|>$/;

/** GGUF `tokenizer.ggml.token_type` enum values (llama.cpp
 *  `LLAMA_TOKEN_TYPE_*`) that mark an entry as a special/added token to
 *  be matched verbatim rather than run through byte-level BPE. NORMAL=1
 *  and BYTE=6 are excluded (ordinary vocabulary). In GGUFs produced by
 *  `convert_hf_to_gguf`'s `_set_vocab_gpt2`, an added token is classified
 *  CONTROL=3 when it is `special` OR not `normalized`, and USER_DEFINED=4
 *  only when it is normalized and not special. Qwen's own added tokens
 *  (`<|im_start|>`, `<|im_end|>`, `<think>`, `</think>`, ...) are all
 *  CONTROL=3 under that rule — USER_DEFINED=4 is reserved for a
 *  normalized, non-special user-added token, which this vocabulary
 *  doesn't have. Both values are accepted here regardless, since the
 *  distinction doesn't matter for this module's purposes. */
const SPECIAL_TOKEN_TYPES = new Set([3, 4]);

function buildVocabTable(tokens: string[], merges: string[], pre: string, tokenType?: number[]): VocabTable {
  const tokenToId = new Map<string, number>();
  tokens.forEach((token, id) => {
    tokenToId.set(token, id);
  });

  const mergeRank = new Map<string, number>();
  merges.forEach((line, rank) => {
    const [first, second] = line.split(" ");
    if (first === undefined || second === undefined) return;
    mergeRank.set(first + PAIR_SEP + second, rank);
  });

  // Prefer the model's own token-type classification (S3-C2): shape-based
  // matching structurally cannot see Qwen3's non-`<|...|>`-shaped control
  // tokens (`<think>`, `<tool_call>`, ...), so a real GGUF vocabulary's
  // `token_type` array is authoritative whenever `/show` provides it.
  // Fall back to the shape regex only when it's absent — e.g. the
  // hand-built fixture predating this fix may not carry the array.
  const specialTokens =
    tokenType && tokenType.length === tokens.length
      ? tokens.filter((_, id) => SPECIAL_TOKEN_TYPES.has(tokenType[id]))
      : tokens.filter((t) => SPECIAL_TOKEN_PATTERN.test(t));

  return {
    tokens,
    tokenToId,
    mergeRank,
    pre,
    specialTokens,
    specialTokenSet: new Set(specialTokens),
  };
}

// ── Vocab acquisition + cache (AC-PERF-1 / Order-Sensitive Flow 1) ────

/**
 * Keyed by `${baseUrl}\u0000${model}`. Stores the in-flight PROMISE itself
 * at call time (not only the resolved value), so a second concurrent
 * caller attaches to the same in-flight request instead of racing a
 * second `/show` call — the requirement AC-PERF-1's Promise.all case
 * specifically catches a resolve-only cache from missing.
 *
 * Bounded LRU (S3-F12): a real qwen3-scale vocabulary retains tens of MB
 * per `(baseUrl, model)` pair (the full token list plus two lookup Maps
 * over it). `VOCAB_CACHE_MAX_ENTRIES` caps how many such tables this
 * process holds at once — this app tokenizes against at most a handful of
 * models in a session, so 3 is deliberately generous headroom rather than
 * a tuned number. `touchVocabCacheEntry` re-inserts a key on every
 * get-or-set to move it to the Map's most-recently-used (last) position;
 * `Map` iteration order is insertion order, so the first key is always the
 * least-recently-used one to consider for eviction.
 *
 * Eviction only ever targets a SETTLED entry (S3-R2): evicting an
 * in-flight promise would (a) drop the one guarantee AC-PERF-1 makes for
 * a given `(baseUrl, model)` pair — a second caller for that same
 * now-evicted key would race a second `/show` — and (b) break the
 * precondition the failure path's `vocabCache.delete(key)` relied on:
 * that a key can never be re-registered while its promise is still in
 * flight. Without that precondition, a stale rejection's cleanup could
 * delete a *different*, newer in-flight promise that happens to share the
 * same key. `settledPromises` tracks which cached promises have resolved
 * or rejected; `touchVocabCacheEntry` walks from least- to
 * most-recently-used and evicts the first settled one it finds, or evicts
 * nothing (temporarily exceeding the cap) if every other entry is still
 * in flight — the next touch retries once something settles.
 */
const vocabCache = new Map<string, Promise<VocabTable>>();
const settledPromises = new WeakSet<Promise<VocabTable>>();
const VOCAB_CACHE_MAX_ENTRIES = 3;

function touchVocabCacheEntry(key: string, promise: Promise<VocabTable>): void {
  vocabCache.delete(key);
  vocabCache.set(key, promise);
  if (vocabCache.size <= VOCAB_CACHE_MAX_ENTRIES) return;

  for (const [candidateKey, candidatePromise] of vocabCache) {
    if (candidateKey === key) continue;
    if (settledPromises.has(candidatePromise)) {
      vocabCache.delete(candidateKey);
      return;
    }
  }
  // Every other entry is still in flight — nothing safe to evict yet.
}

function cacheKey(baseUrl: string, model: string): string {
  return `${baseUrl}${PAIR_SEP}${model}`;
}

async function fetchVocab(baseUrl: string, model: string): Promise<VocabTable> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, verbose: true }),
    });
  } catch (err) {
    throw new VocabUnavailableError(
      `Ollama /show request failed for model "${model}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response.ok) {
    throw new VocabUnavailableError(`Ollama /show failed for model "${model}": ${response.status}`);
  }

  const body = (await response.json()) as ShowVerboseResponse;
  const modelInfo = body.model_info;
  const tokens = modelInfo?.["tokenizer.ggml.tokens"];
  const merges = modelInfo?.["tokenizer.ggml.merges"];
  const pre = modelInfo?.["tokenizer.ggml.pre"];
  // Optional (S3-C2): when present, authoritative for special-token
  // detection (see buildVocabTable). Not required — a response lacking it
  // falls back to shape-based detection rather than failing closed, since
  // its absence doesn't make the vocab itself unusable.
  const tokenType = modelInfo?.["tokenizer.ggml.token_type"];

  if (!Array.isArray(tokens) || !Array.isArray(merges) || typeof pre !== "string") {
    throw new VocabUnavailableError(
      `Ollama /show response for model "${model}" is missing tokenizer.ggml.tokens/merges/pre in model_info`
    );
  }

  if (pre !== SUPPORTED_PRE) {
    // Fail closed (AC-ERR-2 / story scope): an unsupported pre-tokenizer
    // must never silently fall back to a different split algorithm, which
    // would produce boundaries for the wrong vocabulary.
    throw new VocabUnavailableError(
      `Unsupported tokenizer.ggml.pre "${pre}" for model "${model}" — only "${SUPPORTED_PRE}" is implemented`
    );
  }

  return buildVocabTable(
    tokens as string[],
    merges as string[],
    pre,
    Array.isArray(tokenType) ? (tokenType as number[]) : undefined
  );
}

/**
 * Loads (and caches) the vocab/merge table for `(baseUrl, model)`. Two
 * calls for the same key — sequential or concurrent — issue exactly one
 * `POST /show` (AC-PERF-1, Order-Sensitive Composition Flow 1): the
 * in-flight promise is stored in the cache synchronously, before any
 * `await`, so a second caller arriving before the first resolves attaches
 * to the same promise rather than starting a second fetch.
 *
 * A failed load (network error, malformed response, unsupported `pre`) is
 * NOT cached — the next call retries the fetch rather than remembering a
 * transient failure forever.
 */
export function loadVocab(baseUrl: string, model: string): Promise<VocabTable> {
  const key = cacheKey(baseUrl, model);
  const cached = vocabCache.get(key);
  if (cached) {
    touchVocabCacheEntry(key, cached);
    return cached;
  }

  const promise = fetchVocab(baseUrl, model).catch((err) => {
    // S3-R2: delete by key AND identity — the LRU can re-register this
    // key with a newer in-flight promise before this rejection's cleanup
    // runs; deleting unconditionally by key would evict that live entry
    // instead of this stale, already-dead one.
    if (vocabCache.get(key) === promise) vocabCache.delete(key);
    throw err;
  });
  // Side chain only: marks the entry settled (for eviction eligibility)
  // without affecting the rejection `promise` itself delivers to its
  // real caller (loadVocab's return value). The trailing .catch(() => {})
  // exists solely to keep this untracked derived promise from surfacing
  // as an unhandled rejection.
  promise.finally(() => settledPromises.add(promise)).catch(() => {});
  touchVocabCacheEntry(key, promise);
  return promise;
}

/** Test-only: clears the module-level vocab cache between test cases. */
export function __resetVocabCacheForTests(): void {
  vocabCache.clear();
}

// ── Tokenization ────────────────────────────────────────────────────

export interface TokenizeResult {
  tokens: string[];
  tokenIds: number[];
}

function splitOnSpecialTokens(text: string, specialTokens: string[]): string[] {
  if (specialTokens.length === 0) return [text];
  // Longest first so no special token can shadow a longer one that shares
  // a prefix/suffix.
  const sorted = [...specialTokens].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`);
  return text.split(pattern).filter((segment) => segment.length > 0);
}

function encodeToIds(vocab: VocabTable, text: string): number[] {
  const ids: number[] = [];
  const segments = splitOnSpecialTokens(text, vocab.specialTokens);

  for (const segment of segments) {
    if (vocab.specialTokenSet.has(segment)) {
      const id = vocab.tokenToId.get(segment);
      if (id === undefined) {
        throw new Error(`special token missing from vocab.tokenToId: ${JSON.stringify(segment)}`);
      }
      ids.push(id);
      continue;
    }

    for (const preToken of preTokenize(segment)) {
      const byteChars = byteEncode(preToken);
      const merged = bpeMerge(byteChars, vocab.mergeRank);
      for (const symbol of merged) {
        const id = vocab.tokenToId.get(symbol);
        if (id === undefined) {
          throw new Error(
            `BPE produced a symbol absent from the vocabulary: ${JSON.stringify(symbol)} (pre-token ${JSON.stringify(preToken)})`
          );
        }
        ids.push(id);
      }
    }
  }

  return ids;
}

/**
 * Decodes a token-id sequence back into display strings whose
 * concatenation is guaranteed to equal the original encoded text — even
 * when a BPE token boundary falls in the middle of a multi-byte UTF-8
 * character. Real byte-level BPE can and does split multi-byte
 * characters across adjacent tokens (nothing in the merge table
 * guarantees otherwise for arbitrary input); decoding each token
 * independently with a fresh UTF-8 decoder would corrupt such a
 * character or violate the `tokens.join("") === s` invariant AC-TOK-6
 * requires for arbitrary well-formed unicode.
 *
 * The fix: feed every token's raw bytes through ONE streaming
 * `TextDecoder` (per tokenize() call), in id order, with `stream: true`.
 * A decoder in streaming mode buffers an incomplete trailing multi-byte
 * sequence and only emits it once later bytes complete it — so a token
 * that ends mid-character decodes to "" and the character appears
 * (whole) in a later token's output instead. Concatenating all outputs
 * always reconstructs the original text exactly, because the total byte
 * sequence fed to the decoder is exactly the original UTF-8 encoding of
 * that text, replayed in order.
 *
 * `ignoreBOM: true` matters here too: `fc.fullUnicodeString` can legally
 * generate a leading U+FEFF. Without this flag, TextDecoder strips a
 * leading byte-order-mark from the very first decode() call in a
 * streaming session — which would silently drop that character and
 * break the join invariant for that one input.
 */
function decodeTokens(vocab: VocabTable, tokenIds: number[]): string[] {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const encoder = new TextEncoder();
  const tokens: string[] = [];

  for (const id of tokenIds) {
    const vocabEntry = vocab.tokens[id];
    const bytes = vocab.specialTokenSet.has(vocabEntry) ? encoder.encode(vocabEntry) : byteDecodeToBytes(vocabEntry);
    tokens.push(decoder.decode(bytes, { stream: true }));
  }

  const flushed = decoder.decode();
  if (flushed.length > 0) {
    // Should be unreachable for well-formed input (the encoded bytes are
    // always a complete, valid UTF-8 sequence by construction), but if it
    // ever fires, attaching to the last token keeps the join invariant
    // rather than silently dropping trailing content.
    tokens[tokens.length - 1] = (tokens[tokens.length - 1] ?? "") + flushed;
  }

  return tokens;
}

/**
 * Tokenizes `text` against an already-loaded vocab table. Returns
 * `tokens`/`tokenIds` of equal length with `tokens.join("") === text`
 * (AC-TOK-2, AC-TOK-6) and each `tokenIds[i]` naming the vocabulary index
 * whose byte-level decoding produced `tokens[i]` (AC-TOK-2). Special
 * tokens (e.g. `<|im_start|>`) are matched verbatim ahead of the
 * pre-tokenizer split and always occupy exactly one element (AC-TOK-3).
 *
 * The `tokens.join("") === text` guarantee holds only for well-formed
 * input. `byteEncode` goes through `TextEncoder`, which maps a lone UTF-16
 * surrogate to U+FFFD, so a JS string containing an unpaired surrogate
 * breaks the join invariant by construction. Runtime behavior degrades
 * gracefully (the caller's own join check falls back to `unavailable`
 * rather than mislabeling the mismatch) — only the contract stated here
 * needed the qualifier (S3-F13).
 */
export function tokenizeWithVocab(vocab: VocabTable, text: string): TokenizeResult {
  const tokenIds = encodeToIds(vocab, text);
  const tokens = decodeTokens(vocab, tokenIds);
  return { tokens, tokenIds };
}

/**
 * Decodes an explicit token-id sequence back to display strings, using
 * the same streaming-decode logic `tokenize()` uses internally. Exposed
 * for testing AC-TOK-2's "looking up tokenIds[i] in the vocab and
 * applying byte-level decoding MUST yield tokens[i]" independently of a
 * full `tokenize()` call.
 */
export function decodeTokenIds(vocab: VocabTable, tokenIds: number[]): string[] {
  return decodeTokens(vocab, tokenIds);
}

/**
 * Loads (and caches) the vocab for `(baseUrl, model)`, then tokenizes
 * `text` against it. This is the entry point server/llm-router.ts's
 * `tokenizeText` calls for the `tokenize` WS message.
 *
 * Same `tokens.join("") === text` caveat as `tokenizeWithVocab`: holds for
 * well-formed input only (S3-F13).
 */
export async function tokenize(baseUrl: string, model: string, text: string): Promise<TokenizeResult> {
  const vocab = await loadVocab(baseUrl, model);
  return tokenizeWithVocab(vocab, text);
}
