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
      class={{ active: active() }}
      style={{ color: color() }}
      ref={el}
      onScroll={(_e) => {
        setActive(true);
        setColor("blue");
      }}
      prop:value={color()}
    >
      {/* Text and sibling element share a line, matching the MX source, so no
          whitespace-collapsing question arises in this fixture — `attrs`
          tests attributes, and `fixtures/README.md` covers the whitespace
          contract. */}
      <span>static</span>
      <p class={["badge big", { on: active() }]}>shorthand plus object</p>
    </div>
  );
}
