import { scope as _$scope } from "@solidjs/web";
import { escape as _$escape } from "@solidjs/web";
import { ssr as _$ssr } from "@solidjs/web";
import { ssrHydrationKey as _$ssrHydrationKey } from "@solidjs/web";
var _tmpl$ = [
 "<button",
 ">",
 "</button>"
];
import { createSignal } from "solid-js";
export function Counter() {
 const [count, setCount] = createSignal(0);
 var _v$ = _$ssrHydrationKey(), _v$2 = _$scope(() => {
 return _$escape(count());
 });
 return _$ssr(_tmpl$, _v$, _v$2);
}
