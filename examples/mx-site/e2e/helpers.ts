import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsconfigOverride = fileURLToPath(
  new URL("../../../tsconfig.base.json", import.meta.url),
);

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

/** Starts the mx-site dev server on `port` and waits for it to accept requests. */
export async function startDevServer(
  port: number,
): Promise<{ url: string; stop: () => void }> {
  const proc: ChildProcess = spawn(
    "bun",
    ["run", `--tsconfig-override=${tsconfigOverride}`, "src/server.ts"],
    { cwd: root, env: { ...process.env, PORT: String(port) } },
  );

  const url = `http://localhost:${port}`;
  await waitForServer(url);
  return { url, stop: () => proc.kill() };
}

/** Builds the static site into `dist/` and serves it with a plain file server on `port`. */
export async function startStaticServer(
  port: number,
): Promise<{ url: string; stop: () => void }> {
  await new Promise<void>((resolve, reject) => {
    const build = spawn(
      "bun",
      ["run", `--tsconfig-override=${tsconfigOverride}`, "src/build.ts"],
      { cwd: root },
    );
    build.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`static build failed with exit code ${code}`));
    });
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const name = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = `${root}/dist${name}`;
    if (!existsSync(path)) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    createReadStream(path).pipe(response);
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  const baseUrl = `http://localhost:${port}`;
  await waitForServer(baseUrl);
  return { url: baseUrl, stop: () => server.close() };
}
