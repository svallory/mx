import Counter from "../src/Counter.mx";

/** `label` is declared `string` in `Counter.mx`; this must be TS2322. */
export function Wrong() {
  return <Counter label={1} />;
}
