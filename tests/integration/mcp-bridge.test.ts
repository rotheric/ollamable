import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{ connect: ReturnType<typeof vi.fn>; listTools: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  transports: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  connect: vi.fn(),
  listTools: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    listTools = mocks.listTools;
    close = vi.fn().mockResolvedValue(undefined);
    constructor() { mocks.clients.push(this); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined);
    constructor() { mocks.transports.push(this); }
  },
}));
import { McpBridge } from "../../server/tools/mcp-bridge.js";

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.transports.length = 0;
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.listTools.mockReset().mockResolvedValue({ tools: [{ name: "test", inputSchema: { type: "object" } }] });
});

describe("MCP resource ownership", () => {
  it.each(["connect", "listTools"] as const)("disposes resources while %s is pending and never discovers the next server", async (stage) => {
    let release!: (value: unknown) => void;
    mocks[stage].mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const bridge = new McpBridge();
    const connecting = bridge.connect({ first: { command: "unused" }, second: { command: "unused" } }, () => {});
    await vi.waitFor(() => expect(release).toBeDefined());
    await bridge.disconnect();
    expect(mocks.clients[0].close).toHaveBeenCalled();
    expect(mocks.transports[0].close).toHaveBeenCalled();
    release(stage === "connect" ? undefined : { tools: [{ name: "late" }] });
    expect(await connecting).toEqual([]);
    expect(mocks.clients).toHaveLength(1);
    expect(bridge.getToolDefinitions()).toEqual([]);
    expect(bridge.canHandle("late")).toBe(false);
    expect(await bridge.connect({ again: { command: "unused" } }, () => {})).toEqual([]);
    expect(mocks.clients).toHaveLength(1);
  });

  it.each(["connect", "listTools"] as const)("closes failed %s resources and continues other configured servers", async (stage) => {
    mocks[stage].mockRejectedValueOnce(new Error("handshake failed"));
    const bridge = new McpBridge();
    const definitions = await bridge.connect({ failed: { command: "unused" }, healthy: { command: "unused" } }, () => {});
    expect(mocks.clients[0].close).toHaveBeenCalled();
    expect(mocks.transports[0].close).toHaveBeenCalled();
    expect(definitions).toHaveLength(1);
    expect(bridge.canHandle("test")).toBe(true);
    await bridge.disconnect();
    expect(mocks.clients[1].close).toHaveBeenCalled();
    expect(mocks.transports[1].close).toHaveBeenCalled();
    expect(bridge.getToolDefinitions()).toEqual([]);
    expect(bridge.canHandle("test")).toBe(false);
  });
});
