import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** One policy for HTTP and WebSocket upgrades; neither path may bypass it. */
export class AccessPolicy {
  readonly host: string;
  private readonly token: string | undefined;
  private readonly origins: Set<string>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.host = env.BACKEND_HOST ?? "127.0.0.1";
    this.token = env.BACKEND_AUTH_TOKEN || undefined;
    this.origins = new Set((env.BACKEND_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
    for (const origin of this.origins) {
      const url = new URL(origin);
      if (!/^https?:$/.test(url.protocol) || url.origin !== origin) {
        throw new Error("BACKEND_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths.");
      }
    }
    if (!LOOPBACK_HOSTS.has(this.host) && (!this.token || this.origins.size === 0)) {
      throw new Error("Remote binding requires BACKEND_AUTH_TOKEN and BACKEND_ALLOWED_ORIGINS.");
    }
  }

  private allowedOrigins(port: number): Set<string> {
    return new Set([
      `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`,
      ...this.origins,
    ]);
  }

  check(req: IncomingMessage, port: number): { status: 200 | 401 | 403; origin?: string } {
    const allowed = this.allowedOrigins(port);
    // Host validation also prevents DNS rebinding against an unauthenticated local server.
    let hostname: string;
    try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { return { status: 403 }; }
    const allowedHosts = new Set([...allowed].map((origin) => new URL(origin).hostname));
    if (!allowedHosts.has(hostname)) return { status: 403 };
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) return { status: 403 };
    // Preflight carries no credentials; allow only approved origins and never execute work.
    if (req.method !== "OPTIONS" && this.token) {
      const expected = Buffer.from(`Bearer ${this.token}`);
      const received = Buffer.from(req.headers.authorization ?? "");
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { status: 401 };
    }
    return { status: 200, origin };
  }
}
