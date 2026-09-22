/**
 * Live-gate helper for the tokenizer conformance suite (AC-ERR-3).
 *
 * Test-only: decides whether AC-TOK-1 (and S4's AC-TOK-5) may run against
 * a real Ollama host. The gate is CLOSED when `OLLAMA_URL` is unreachable
 * OR when `GET {OLLAMA_URL}/tags` does not list the fixture model — with a
 * reason that distinguishes the two, so a skipped run says *why*. Closed
 * means the live-gated tests report skipped, never failed and never
 * passed; every fixture-backed test in the same suite still runs
 * regardless of gate state.
 */

const GATE_TIMEOUT_MS = 2_000;

export interface LiveGateResult {
  open: boolean;
  reason?: "host_unreachable" | "model_not_pulled";
}

export function tokenizerLiveOllamaUrl(): string {
  return process.env.OLLAMA_URL ?? "http://localhost:11434/api";
}

export async function checkLiveGate(baseUrl: string, model: string): Promise<LiveGateResult> {
  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
    try {
      response = await fetch(`${baseUrl}/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return { open: false, reason: "host_unreachable" };
  }

  if (!response.ok) {
    return { open: false, reason: "host_unreachable" };
  }

  const body = (await response.json().catch(() => null)) as { models?: Array<{ name?: string }> } | null;
  const names = body?.models?.map((m) => m.name) ?? [];
  if (!names.includes(model)) {
    return { open: false, reason: "model_not_pulled" };
  }

  return { open: true };
}
