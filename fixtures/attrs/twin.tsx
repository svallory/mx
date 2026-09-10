import { createSignal } from "solid-js";

export function Attrs(props: { extra?: Record<string, unknown> }) {
  const [active, setActive] = createSignal(false);
  const [color, setColor] = createSignal("red");
  let el: HTMLDivElement | undefined;

  return (
    <div
      id="panel"
      data-count={color()}
      disabled={true}
      {...props.extra}
      classList={{ active: active() }}
      style={{ color: color() }}
      ref={el}
      on:scroll={() => {
        setActive(true);
        setColor("blue");
      }}
      prop:value={color()}
      attr:title={color()}
      bool:open={active()}
    >
      static
    </div>
  );
}
