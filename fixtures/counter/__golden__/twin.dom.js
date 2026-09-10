import { template as _$template } from "solid-js/web";
import { delegateEvents as _$delegateEvents } from "solid-js/web";
import { insert as _$insert } from "solid-js/web";
var _tmpl$ = /*#__PURE__*/_$template(`<button>`);
import { createSignal } from "solid-js";
export function Counter() {
 const [count, setCount] = createSignal(0);
 return (() => {
 var _el$ = _tmpl$();
 _el$.$$click = () => {
 setCount(count() + 1);
 };
 _$insert(_el$, count);
 return _el$;
 })();
}
_$delegateEvents(["click"]);