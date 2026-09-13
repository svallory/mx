/** A hand-written Hono JSX child that proves the emitted ErrorBoundary catches. */
export function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error("boom from a Hono child");
  return <p data-testid="boom-ok">child rendered fine</p>;
}
