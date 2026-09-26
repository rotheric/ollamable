import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{ connect: ReturnType<typeof vi.fn>; listTools: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn> }>,
  transportOptions: [] as Array<{ command: string; args?: string[]; env?: Record<string, string> }>,
  transports: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  connect: vi.fn(),
  listTools: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    connect = mocks.connect;
    listTools = mocks.listTools;
    close = vi.fn().mockResolvedValue(undefined);
    constructor() { mocks.clients.push(this); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(options: { command: string; args?: string[]; env?: Record<string, string> }) { mocks.transportOptions.push(options); mocks.transports.push(this); }
  },
}));
import { McpBridge } from "../../server/tools/mcp-bridge.js";
import config from "../../server/mcp-config.json";

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.transports.length = 0;
  mocks.transportOptions.length = 0;
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
  it("rejects duplicate names across servers without overwriting the first implementation", async () => {
    const bridge = new McpBridge();
    const emit = vi.fn();
    const definitions = await bridge.connect({ first: { command: "unused" }, second: { command: "unused" } }, emit);
    expect(definitions).toHaveLength(1);
    expect(definitions[0].id).toBe("mcp-first-test");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ title: "MCP Tool Rejected", data: { server: "second", tool: "test" } }));
    await bridge.execute("test", {}, () => {});
    expect(mocks.clients[0].callTool).toHaveBeenCalledOnce();
    expect(mocks.clients[1].callTool).not.toHaveBeenCalled();
    await bridge.disconnect();
  });

  it("rejects MCP names reserved by built-ins while retaining unrelated tools", async () => {
    mocks.listTools.mockResolvedValue({ tools: [{ name: "curl" }, { name: "web_search" }, { name: "unique" }] });
    const bridge = new McpBridge(["curl", "web_search"]);
    const emit = vi.fn();
    const definitions = await bridge.connect({ first: { command: "unused" } }, emit);
    expect(definitions.map((tool) => tool.name)).toEqual(["unique"]);
    expect(bridge.canHandle("curl")).toBe(false);
    expect(bridge.canHandle("web_search")).toBe(false);
    expect(emit.mock.calls.filter(([event]) => event.title === "MCP Tool Rejected")).toHaveLength(2);
    await bridge.disconnect();
  });

});

it("launches the pinned portable default with explicit browser overrides and operator precedence", async () => {
  vi.stubEnv("PLAYWRIGHT_MCP_EXECUTABLE_PATH", "/operator/browser");
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "/operator/cache");
  vi.stubEnv("BACKEND_AUTH_TOKEN", "must-not-be-forwarded");
  const bridge = new McpBridge();
  await bridge.connect(config.mcpServers, () => {});
  expect(mocks.transportOptions[0]).toMatchObject({
    command: "npx", args: ["@playwright/mcp@0.0.82", "--headless"],
    env: { PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/operator/browser", PLAYWRIGHT_BROWSERS_PATH: "/operator/cache" },
  });
  expect(mocks.transportOptions[0].env).not.toHaveProperty("BACKEND_AUTH_TOKEN");
  await bridge.disconnect();
  const custom = new McpBridge();
  await custom.connect({ playwright: { ...config.mcpServers.playwright, env: { PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/configured/browser" } } }, () => {});
  expect(mocks.transportOptions[1].env?.PLAYWRIGHT_MCP_EXECUTABLE_PATH).toBe("/configured/browser");
  await custom.disconnect();
});
