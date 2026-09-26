import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [
  ["Project record consistency", ["scripts/check-project-records.mjs"]],
  ["Unit tests", ["node_modules/vitest/vitest.mjs", "run"]],
  ["Server integration tests", ["node_modules/vitest/vitest.mjs", "run", "-c", "vitest.server.config.ts"]],
  ["Frontend and test types", ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"]],
  ["Backend types", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json", "--noEmit", "--incremental", "false"]],
  ["Static production build", ["node_modules/next/dist/bin/next", "build"]],
  ["Browser tests (mocked UI and real backend/provider/tool)", ["scripts/run-playwright.mjs", "--skip-build"]],
];
let active;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => active?.kill(signal));
for (const [label, args] of checks) {
  console.log(`\n[check] ${label}`);
  active = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
  const code = await new Promise((resolve, reject) => { active.once("error", reject); active.once("exit", (code) => resolve(code ?? 1)); });
  if (code !== 0) { process.exitCode = code; break; }
}
