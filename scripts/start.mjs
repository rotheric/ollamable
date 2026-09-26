import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts", "--require-static-export"], {
  cwd: root, stdio: "inherit", env: process.env,
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(error.message); process.exit(1); });
child.once("exit", (code, signal) => process.exit(code ?? (signal === "SIGINT" ? 130 : 143)));
