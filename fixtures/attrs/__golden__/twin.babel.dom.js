import { template as _$template } from "@solidjs/web";
import { effect as _$effect } from "@solidjs/web";
import { ref as _$ref } from "@solidjs/web";
import { spread as _$spread } from "@solidjs/web";
import { mergeProps as _$mergeProps } from "@solidjs/web";
var _tmpl$ = /*#__PURE__*/_$template(`<div><span>static</span><p class="badge big">shorthand plus object`);
import { createSignal } from "solid-js";
export function Attrs(props) {
 const [active, setActive] = createSignal(false);
 const [color, setColor] = createSignal("red");
 let el;
 var _el$ = _tmpl$(),
 _el$2 = _el$.firstChild,
 _el$3 = _el$2.nextSibling;
 var _ref$ = el;
 typeof _ref$ === "function" || Array.isArray(_ref$) ? _$ref(() => _ref$, _el$) : el = _el$;
 _$spread(_el$, _$mergeProps({
 "id": "panel",
 get ["data-count"]() {
 return color();
 },
 "disabled": true
 }, () => props.extra, {
 get ["class"]() {
 return {
 active: active()
 };
 },
 get style() {
 return {
 color: color()
 };
 },
 "onScroll": _e => {
 setActive(true);
 setColor("blue");
 },
 get ["prop:value"]() {
 return color();
 }
 }), true);
 _$effect(() => !!active(), _v$ => {
 _el$3.classList.toggle("on", _v$);
 });
 return _el$;
}