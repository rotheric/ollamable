import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolExecutor } from "../tool-executor.js";
import type { MetaEvent, ToolDefinition } from "../types.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: string[];
}

export class McpBridge implements ToolExecutor {
  private servers: ConnectedServer[] = [];
  private disposed = false;
  private toolToServer = new Map<string, ConnectedServer>();
  private toolDefs: ToolDefinition[] = [];

  getToolDefinitions(): ToolDefinition[] {
    return this.toolDefs;
  }

  canHandle(name: string): boolean {
    return this.toolToServer.has(name);
  }

  async connect(
    configs: Record<string, McpServerConfig>,
    emit: (event: MetaEvent) => void
  ): Promise<ToolDefinition[]> {
    if (this.disposed) return [];
    this.toolDefs = [];
    const discoveredTools: ToolDefinition[] = [];

    for (const [name, config] of Object.entries(configs)) {
      if (this.disposed) break;
      let server: ConnectedServer | undefined;
      try {
        emit({
          id: randomUUID(),
          kind: "mcp_connect",
          title: "MCP Connect",
          detail: `Connecting to MCP server: ${name}`,
          data: { server: name, command: config.command },
          timestamp: new Date().toISOString(),
        });

        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
        });

        const client = new Client(
          { name: "ollamable", version: "0.1.0" },
          { capabilities: {} }
        );

        // Own resources before the first await so disconnect can always close them.
        server = { name, client, transport, tools: [] };
        this.servers.push(server);
        await client.connect(transport);
        if (this.disposed) {
          await this.closeServer(server);
          break;
        }

        const toolsResult = await client.listTools();
        if (this.disposed) {
          await this.closeServer(server);
          break;
        }
        const toolNames = toolsResult.tools.map((t) => t.name);
        server.tools = toolNames;

        for (const tool of toolsResult.tools) {
          this.toolToServer.set(tool.name, server);
          discoveredTools.push({
            id: `mcp-${name}-${tool.name}`,
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: JSON.stringify(tool.inputSchema ?? {}),
          });
        }

        emit({
          id: randomUUID(),
          kind: "mcp_connect",
          title: "MCP Connected",
          detail: `${name}: discovered ${toolNames.length} tool(s) — ${toolNames.join(", ")}`,
          data: { server: name, tools: toolNames },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        if (server) {
          this.servers = this.servers.filter((entry) => entry !== server);
          await this.closeServer(server);
        }
        if (this.disposed) break;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        emit({
          id: randomUUID(),
          kind: "mcp_connect",
          title: "MCP Connection Failed",
          detail: `${name}: ${message}`,
          data: { server: name, error: message },
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (this.disposed) return [];
    this.toolDefs = discoveredTools;
    return discoveredTools;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    emit: (event: MetaEvent) => void,
    signal?: AbortSignal
  ): Promise<string> {
    signal?.throwIfAborted();
    const server = this.toolToServer.get(name);
    if (!server) {
      return JSON.stringify({ error: `No MCP server handles tool: ${name}` });
    }

    const startTime = Date.now();

    emit({
      id: randomUUID(),
      kind: "mcp_call",
      title: "MCP Tool Call",
      detail: `Calling ${name} on ${server.name}`,
      data: { server: server.name, tool: name, arguments: args },
      timestamp: new Date().toISOString(),
    });

    try {
      const result = await server.client.callTool({
        name,
        arguments: args,
      }, undefined, { signal });

      const durationMs = Date.now() - startTime;
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");

      emit({
        id: randomUUID(),
        kind: "mcp_result",
        title: "MCP Result",
        detail: `${name} completed in ${durationMs}ms`,
        data: {
          server: server.name,
          tool: name,
          resultLength: text.length,
          durationMs,
        },
        timestamp: new Date().toISOString(),
        durationMs,
      });

      return text || JSON.stringify(result.content);
    } catch (error) {
      signal?.throwIfAborted();
      const durationMs = Date.now() - startTime;
      const message =
        error instanceof Error ? error.message : "Unknown MCP error";

      emit({
        id: randomUUID(),
        kind: "mcp_result",
        title: "MCP Error",
        detail: `${name} failed: ${message}`,
        data: { server: server.name, tool: name, error: message },
        timestamp: new Date().toISOString(),
        durationMs,
      });

      return JSON.stringify({ error: message });
    }
  }

  private async closeServer(server: ConnectedServer): Promise<void> {
    try {
      await server.client.close();
    } catch {
      // A failed handshake may not have attached its transport to the client.
    } finally {
      try { await server.transport.close(); } catch { /* best effort */ }
    }
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    const servers = this.servers.splice(0);
    this.toolToServer.clear();
    this.toolDefs = [];
    await Promise.all(servers.map((server) => this.closeServer(server)));
  }
}
