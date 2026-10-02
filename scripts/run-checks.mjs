import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedCheckout, wantsInPlace } from "./isolated-checkout.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The build and browser stages write .next/out; run them in a copy so a live
// dev server in this checkout keeps serving its own build. --in-place opts out.
const isolated = wantsInPlace() ? undefined : await createIsolatedCheckout(root);
const workdir = isolated?.dir ?? root;
if (isolated) console.log(`[check] running in isolated copy ${workdir}`);
const checks = [
  ["Project record consistency", ["scripts/check-project-records.mjs"]],
  ["Lint", ["node_modules/eslint/bin/eslint.js", ".", "--max-warnings", "0"]],
  ["Unit tests", ["node_modules/vitest/vitest.mjs", "run"]],
  ["Server integration tests", ["node_modules/vitest/vitest.mjs", "run", "-c", "vitest.server.config.ts"]],
  ["Frontend and test types", ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"]],
  ["Backend types", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json", "--noEmit", "--incremental", "false"]],
  ["Static production build", ["node_modules/next/dist/bin/next", "build"]],
  ["Browser tests (mocked UI and real backend/provider/tool)", ["scripts/run-playwright.mjs", "--skip-build", "--in-place"]],
];
let active;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => active?.kill(signal));
for (const [label, args] of checks) {
  console.log(`\n[check] ${label}`);
  active = spawn(process.execPath, args, { cwd: workdir, stdio: "inherit", env: process.env });
  const code = await new Promise((resolve, reject) => { active.once("error", reject); active.once("exit", (code) => resolve(code ?? 1)); });
  if (code !== 0) { process.exitCode = code; break; }
}
if (isolated) {
  if (process.exitCode) console.log(`[check] failed; build output and traces are kept in ${workdir}`);
  else await isolated.cleanup();
}
