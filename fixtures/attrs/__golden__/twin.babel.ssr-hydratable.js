import { ssrElement as _$ssrElement } from "@solidjs/web";
import { mergeProps as _$mergeProps } from "@solidjs/web";
import { ssrClassName as _$ssrClassName } from "@solidjs/web";
import { ssr as _$ssr } from "@solidjs/web";
var _tmpl$ = "<span>static</span>",
 _tmpl$2 = ["<p class=\"", "\">shorthand plus object</p>"];
import { createSignal } from "solid-js";
export function Attrs(props) {
 var _v$;
 const [active, setActive] = createSignal(false);
 const [color, setColor] = createSignal("red");
 let el;
 return _$ssrElement("div", () => _$mergeProps({
 id: "panel",
 get ["data-count"]() {
 return color();
 },
 disabled: true
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
 }
 }), () => [_$ssr(_tmpl$), (_v$ = () => _$ssrClassName(["badge big", {
 on: active()
 }]), _$ssr(_tmpl$2, _v$))], true);
}