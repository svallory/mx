/** A hand-written React child that proves the emitted boundary catches. */
export function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error("boom from a React child");
  return <p data-testid="boom-ok">child rendered fine</p>;
}
