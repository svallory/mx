import { template as _$template } from "solid-js/web";
import { setBoolAttribute as _$setBoolAttribute } from "solid-js/web";
import { setAttribute as _$setAttribute } from "solid-js/web";
import { effect as _$effect } from "solid-js/web";
import { use as _$use } from "solid-js/web";
import { spread as _$spread } from "solid-js/web";
import { mergeProps as _$mergeProps } from "solid-js/web";
var _tmpl$ = /*#__PURE__*/_$template(`<div id=panel>static`);
import { createSignal } from "solid-js";
export function Attrs(props) {
 const [active, setActive] = createSignal(false);
 const [color, setColor] = createSignal("red");
 let el;
 return (() => {
 var _el$ = _tmpl$();
 var _ref$ = el;
 typeof _ref$ === "function" ? _$use(_ref$, _el$) : el = _el$;
 _el$.disabled = true;
 _$spread(_el$, _$mergeProps({
 get ["data-count"]() {
 return color();
 }
 }, () => props.extra, {
 get classList() {
 return {
 active: active()
 };
 },
 get style() {
 return {
 color: color()
 };
 },
 "on:scroll": () => {
 setActive(true);
 setColor("blue");
 }
 }), false, true);
 _$effect(_p$ => {
 var _v$ = color(),
 _v$2 = color(),
 _v$3 = active();
 _v$ !== _p$.e && (_el$.value = _p$.e = _v$);
 _v$2 !== _p$.t && _$setAttribute(_el$, "title", _p$.t = _v$2);
 _v$3 !== _p$.a && _$setBoolAttribute(_el$, "open", _p$.a = _v$3);
 return _p$;
 }, {
 e: undefined,
 t: undefined,
 a: undefined
 });
 return _el$;
 })();
}