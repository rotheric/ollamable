/**
 * Minimal ambient declarations for capture-vocab-fixture.mjs, so
 * tests/integration/capture-vocab-fixture.test.ts (a .ts file) can import
 * it with types. The frontend tsconfig.json has `allowJs: false` and no
 * bundled types for plain .mjs modules; `scripts/` itself has no
 * tsconfig of its own (it's plain Node ESM, run directly via `node`).
 */

export const FIXTURE_SET: string[];

export function modelSlugFor(model: string): string;

export interface CaptureResult {
  vocabPath: string;
  vocabGzip: Buffer;
  goldensPath: string;
  goldensJson: string;
}

export interface RunOptions {
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  referenceTokenizeImpl?: (text: string, model: string) => Promise<number[]>;
  fixturesDir?: string;
  write?: (path: string, content: string | Buffer) => void;
  log?: (...args: unknown[]) => void;
}

export function run(options: RunOptions): Promise<CaptureResult>;

export function referenceTokenize(text: string, model: string): Promise<number[]>;

export function parseLlamaTokenizeIds(out: string): number[];
