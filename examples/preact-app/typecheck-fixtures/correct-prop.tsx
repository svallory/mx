import Counter from "../src/Counter.mx";

/** The prop types come from `Counter.mx`'s own `export interface Input`. */
export function Correct() {
  return <Counter label="typed from Input" start={1} />;
}
