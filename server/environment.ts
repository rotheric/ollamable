import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/** Node dotenv syntax only: no shell execution or variable interpolation. */
export function loadEnvironment(root: string, env: Record<string, string | undefined> = process.env): void {
  for (const filename of [".env", ".envrc"]) {
    let raw: string;
    try { raw = readFileSync(resolve(root, filename), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const [key, value] of Object.entries(parseEnv(raw))) {
      // Even an explicitly empty process variable wins. .env takes priority over .envrc.
      if (env[key] === undefined) env[key] = value;
    }
  }
}
