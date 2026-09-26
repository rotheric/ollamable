import { spawn } from "node:child_process";
import { createServer } from "node:net";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

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

function openBrowser(url) {
  if (process.env.OPEN_BROWSER === "0") {
    return;
  }

  let command;
  let args;

  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawn(command, args, {
    stdio: "ignore",
    detached: true,
  });

  child.on("error", () => {
    // Best effort only. The dev server should still run if the browser cannot be opened.
  });
  child.unref();
}

const port = process.env.PORT ?? "3000";
const url = `http://127.0.0.1:${port}`;

console.log(`Starting dev server on ${url}`);
openBrowser(url);

const children = [];

const backendPort = String(Number(port) + 1);
const backend = spawn(npmCommand, ["run", "dev:server"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: backendPort,
    BACKEND_ALLOWED_ORIGINS: process.env.BACKEND_ALLOWED_ORIGINS ?? `http://127.0.0.1:${port},http://localhost:${port}`,
  },
});
children.push(backend);

const frontend = spawn(
  npmCommand,
  ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", port],
  {
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${backendPort}` },
  }
);
children.push(frontend);

function shutdown(codeOrSignal) {
  for (const child of children) {
    child.kill();
  }

  if (typeof codeOrSignal === "string") {
    process.kill(process.pid, codeOrSignal);
  } else {
    process.exit(codeOrSignal ?? 0);
  }
}

frontend.on("exit", (code, signal) => shutdown(signal ?? code));
backend.on("exit", (code, signal) => shutdown(signal ?? code));
