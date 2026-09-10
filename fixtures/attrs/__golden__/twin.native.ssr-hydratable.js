import { ssr as _$ssr } from "@solidjs/web";
import { ssrClassName as _$ssrClassName } from "@solidjs/web";
import { ssrElement as _$ssrElement } from "@solidjs/web";
import { mergeProps as _$mergeProps } from "@solidjs/web";
var _tmpl$ = ["<p class=\"", "\">shorthand plus object</p>"];
import { createSignal } from "solid-js";
export function Attrs(props) {
 var _v$;
 const [active, setActive] = createSignal(false);
 const [color, setColor] = createSignal("red");
 let el;
 return _$ssrElement("div", () => {
 return _$mergeProps({
 id: "panel",
 get ["data-count"]() {
 return color();
 },
 disabled: true
 }, () => {
 return props.extra;
 }, {
 get ["class"]() {
 return { active: active() };
 },
 get style() {
 return { color: color() };
 }
 });
 }, () => {
 return ["static", (_v$ = () => {
 return _$ssrClassName(["badge big", { on: active() }]);
 }, _$ssr(_tmpl$, _v$))];
 }, true);
}
