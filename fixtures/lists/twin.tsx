import { createSignal } from "solid-js";

interface Row {
  id: number;
  label: string;
}

export function Lists() {
  // Setters are unused: the fixture exercises lowering shapes, not behavior.
  const [rows, _setRows] = createSignal<Row[]>([]);
  const [count, _setCount] = createSignal(3);
  const [meta, _setMeta] = createSignal<Record<string, string>>({});

  return (
    <div>
      {/* custom key by field name: by="id" */}
      <For each={rows()} keyed={(x) => x.id}>
        {(row, i) => (
          <li>
            {i()}: {row().label}
          </li>
        )}
      </For>
      {/* custom key by function: by=(fn) */}
      <For each={rows()} keyed={(r) => r.label}>
        {/* biome-ignore lint/correctness/noUnusedFunctionParameters: mirrors the MX `<for|row, i|>` param list */}
        {(row, i) => <li>{row().label}</li>}
      </For>
      {/* inclusive range: from=1 to=count() */}
      <Repeat count={count() - 1 + 1} from={1}>
        {(i) => <span>{i}</span>}
      </Repeat>
      {/* exclusive range with literal bounds, folded at lowering time */}
      <Repeat count={4}>{(i) => <b>{i}</b>}</Repeat>
      {/* object entries, keyed by the entry key */}
      <For each={Object.entries(meta())} keyed={(e) => e[0]}>
        {([k, v]) => (
          <p>
            {k}={v}
          </p>
        )}
      </For>
    </div>
  );
}
