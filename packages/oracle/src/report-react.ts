import { renderReact } from "./react-render";
import { runJsxHostTable } from "./report-preact";

/** React DOM static-render parity over the stock Marko fixture set. */
export function runReactTable(): ReturnType<typeof runJsxHostTable> {
  return runJsxHostTable("React", renderReact);
}
