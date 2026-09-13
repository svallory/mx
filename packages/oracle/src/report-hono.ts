import { renderHono } from "./hono-render";
import { runJsxHostTable } from "./report-preact";

/** Hono JSX static-render parity over the stock Marko fixture set. */
export function runHonoTable(): ReturnType<typeof runJsxHostTable> {
  return runJsxHostTable("Hono", renderHono);
}
