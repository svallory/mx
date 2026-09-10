import { ssr as _$ssr } from "solid-js/web";
import { escape as _$escape } from "solid-js/web";
import { ssrHydrationKey as _$ssrHydrationKey } from "solid-js/web";
var _tmpl$ = ["<button", ">", "</button>"];
import { createSignal } from "solid-js";
export function Counter() {
 const [count, setCount] = createSignal(0);
 return _$ssr(_tmpl$, _$ssrHydrationKey(), _$escape(count()));
}