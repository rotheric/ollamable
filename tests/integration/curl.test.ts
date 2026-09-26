import { afterEach, describe, expect, it, vi } from "vitest";
import { CurlExecutor } from "../../server/tools/curl.js";

afterEach(() => vi.restoreAllMocks());

describe("curl response limits", () => {
  it.each(["text/plain", "application/octet-stream"])("cancels a large %s stream at the requested cap", async (contentType) => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(4096).fill(65));
        if (pulls === 10000) controller.close();
      },
      cancel,
    }, { highWaterMark: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { headers: { "content-type": contentType } }));
    const result = JSON.parse(await new CurlExecutor().execute("curl", { url: "https://example.com", max_bytes: 1000 }, () => {}));
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBe(1);
    expect(result.bytes).toBe(1000);
    expect(result.observedBytes).toBe(4096);
    expect(result.truncated).toBe(true);
    if (contentType === "text/plain") expect(result.body).toBe("A".repeat(1000));
    else expect(result.body).toContain("1000 retained bytes");
  });

  it("preserves complete smaller UTF-8 responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Grüße", { headers: { "content-type": "text/plain" } }));
    const result = JSON.parse(await new CurlExecutor().execute("curl", { url: "https://example.com", max_bytes: 100 }, () => {}));
    expect(result).toMatchObject({ body: "Grüße", bytes: 7, observedBytes: 7, truncated: false });
  });

  it("enforces the 2 MiB hard cap when the requested limit is larger", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel,
    }, { highWaterMark: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    const result = JSON.parse(await new CurlExecutor().execute("curl", { url: "https://example.com", max_bytes: 1e9 }, () => {}));
    expect(result.bytes).toBe(2 * 1024 * 1024);
    expect(pulls).toBe(32);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
