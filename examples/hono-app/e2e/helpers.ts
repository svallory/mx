import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Waits until `url` responds or `timeoutMs` elapses. */
async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // Server not up yet; retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server at ${url} did not respond within ${timeoutMs}ms`);
}

/** Starts the hono-app dev server on `port` and waits for it to accept requests. */
export async function startDevServer(
  port: number,
): Promise<{ url: string; stop: () => void }> {
  const proc: ChildProcess = spawn("bun", ["run", "src/server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
  });

  const url = `http://localhost:${port}`;
  await waitForServer(url);
  return { url, stop: () => proc.kill() };
}
