import { afterEach, describe, expect, it, vi } from "vitest";

/** WS_URL is computed once at import, so each case imports a fresh copy of the module. */
async function wsUrl(): Promise<string> {
  vi.resetModules();
  return (await import("@/src/lib/backend-client")).WS_URL;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("WS_URL", () => {
  it("uses NEXT_PUBLIC_WS_URL when the build sets it (separate dev frontend and backend ports)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "ws://host.lima.internal:3001");
    vi.stubGlobal("window", { location: { protocol: "https:", host: "ignored.example" } });

    expect(await wsUrl()).toBe("ws://host.lima.internal:3001");
  });

  it("otherwise connects back to the page's own host, over ws for an http page", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    vi.stubGlobal("window", { location: { protocol: "http:", host: "127.0.0.1:3000" } });

    expect(await wsUrl()).toBe("ws://127.0.0.1:3000");
  });

  it("uses wss for an https page, so a TLS reverse proxy does not cause a mixed-content block", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    vi.stubGlobal("window", { location: { protocol: "https:", host: "chat.example" } });

    expect(await wsUrl()).toBe("wss://chat.example");
  });

  it("falls back to the default local server outside a browser (static prerender)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    vi.stubGlobal("window", undefined);

    expect(await wsUrl()).toBe("ws://localhost:3000");
  });
});
