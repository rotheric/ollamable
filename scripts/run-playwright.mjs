import { spawn } from "node:child_process";
import { createServer } from "node:net";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const pythonCommand = process.platform === "win32" ? "python" : "python3";

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a local port."));
        return;
      }

      const { port } = address;
      server.close(() => resolve(String(port)));
    });

    server.on("error", reject);
  });
}

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;

async function runCommand(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env },
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });

    child.on("error", reject);
  });
}

await runCommand(npmCommand, ["run", "build"]);

const server = spawn(
  pythonCommand,
  ["-m", "http.server", port, "--bind", "127.0.0.1", "--directory", "out"],
  {
    stdio: "inherit",
    env: { ...process.env },
  }
);

let settled = false;

async function waitForServer(timeoutMs = 120000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(`Dev server exited early with code ${server.exitCode}`);
    }

    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the dev server is reachable.
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for ${baseUrl}`);
}

function stopServer() {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopServer();
  process.exit(143);
});

try {
  await waitForServer();

  // Forward argv so the canonical command can be scoped and fail-fast:
  // `npm run test:e2e -- --max-failures=1`, a spec path, or `-g <pattern>`.
  // Without this every invocation is an unscoped full run.
  const runner = spawn(npxCommand, ["playwright", "test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_BASE_URL: baseUrl,
    },
  });

  const exitCode = await new Promise((resolve, reject) => {
    runner.on("exit", resolve);
    runner.on("error", reject);
  });

  settled = true;
  stopServer();
  process.exit(exitCode ?? 1);
} catch (error) {
  stopServer();
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(settled ? 1 : 1);
}
