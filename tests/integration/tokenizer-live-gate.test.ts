/**
 * tests/integration/tokenizer-live-gate.test.ts — AC-ERR-3 conformance.
 *
 * Covers the gate-check helper itself (host-unreachable vs
 * model-not-pulled, distinct reasons) with a mocked fetch. The
 * end-to-end claim — "running the suite with OLLAMA_URL pointed at a
 * closed port exits zero with a non-zero skip count, and every
 * fixture-backed test still reports pass/fail" — is demonstrated by
 * tokenizer.test.ts's own AC-TOK-1 `it` actually using `ctx.skip()`
 * (verified manually: `OLLAMA_URL=http://127.0.0.1:1 npx vitest run -c
 * vitest.server.config.ts` exits 0 with exactly 1 skipped test and every
 * other test in the suite reporting a real pass/fail verdict — this repo
 * has no CI runner to wire that invocation into as an automated
 * assertion, per architecture.md's "no CI config in this repo" note).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkLiveGate } from "./tokenizer-live-gate.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AC-ERR-3: live gate distinguishes host-unreachable from model-not-pulled", () => {
  it("reports host_unreachable when the host cannot be reached at all", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const gate = await checkLiveGate("http://127.0.0.1:1/api", "qwen3:1.7b");
    expect(gate).toEqual({ open: false, reason: "host_unreachable" });
  });

  it("reports host_unreachable when /tags responds with a non-OK status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    const gate = await checkLiveGate("http://fake/api", "qwen3:1.7b");
    expect(gate).toEqual({ open: false, reason: "host_unreachable" });
  });

  it("reports model_not_pulled when the host is reachable but the fixture model is absent from /tags", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "llama3:latest" }] }), { status: 200 })
    );
    const gate = await checkLiveGate("http://fake/api", "qwen3:1.7b");
    expect(gate).toEqual({ open: false, reason: "model_not_pulled" });
  });

  it("reports open when the host is reachable and the fixture model is listed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "qwen3:1.7b" }] }), { status: 200 })
    );
    const gate = await checkLiveGate("http://fake/api", "qwen3:1.7b");
    expect(gate).toEqual({ open: true });
  });
});
