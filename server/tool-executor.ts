import type { MetaEvent, ToolDefinition } from "./types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { isRecord } from "./request-validation.js";

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
  private validators = new Map<string, { schema: string; validate: ReturnType<AjvJsonSchemaValidator["getValidator"]> }>();

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
    if (!isRecord(args)) throw new Error(`Invalid arguments for tool ${name}: expected a JSON object`);
    const definition = executor.getToolDefinitions().find((tool) => tool.name === name);
    if (!definition) throw new Error(`Missing server schema for tool ${name}`);
    let validator = this.validators.get(name);
    if (!validator || validator.schema !== definition.inputSchema) {
      try {
        const schema: unknown = JSON.parse(definition.inputSchema);
        if (!isRecord(schema)) throw new Error("expected an object schema");
        // Separate compiler instances prevent unrelated tools reusing the same $id.
        validator = { schema: definition.inputSchema, validate: new AjvJsonSchemaValidator().getValidator(schema) };
        this.validators.set(name, validator);
      } catch {
        throw new Error(`Invalid server schema for tool ${name}`);
      }
    }
    const validation = validator.validate(args);
    if (!validation.valid) throw new Error(`Invalid arguments for tool ${name}: ${validation.errorMessage}`);
    return executor.execute(name, args, emit, signal);
  }
}
