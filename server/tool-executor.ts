import type { MetaEvent, ToolDefinition } from "./types.js";

export interface ToolExecutor {
  getToolDefinitions(): ToolDefinition[];
  canHandle(name: string): boolean;
  execute(
    name: string,
    args: Record<string, unknown>,
    emit: (event: MetaEvent) => void,
    signal?: AbortSignal
  ): Promise<string>;
}

export class ToolDispatcher {
  private executors: ToolExecutor[] = [];

  register(executor: ToolExecutor): void {
    this.executors.push(executor);
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.executors.flatMap((e) => e.getToolDefinitions());
  }

  canHandle(name: string): boolean {
    return this.executors.some((e) => e.canHandle(name));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    emit: (event: MetaEvent) => void,
    signal?: AbortSignal
  ): Promise<string> {
    signal?.throwIfAborted();
    const executor = this.executors.find((e) => e.canHandle(name));
    if (!executor) {
      return JSON.stringify({ error: `No executor found for tool: ${name}` });
    }
    return executor.execute(name, args, emit, signal);
  }
}
