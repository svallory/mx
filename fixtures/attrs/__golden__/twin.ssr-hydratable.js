import { ssrElement as _$ssrElement } from "solid-js/web";
import { mergeProps as _$mergeProps } from "solid-js/web";
import { createSignal } from "solid-js";
export function Attrs(props) {
 const [active, setActive] = createSignal(false);
 const [color, setColor] = createSignal("red");
 let el;
 return _$ssrElement("div", _$mergeProps({
 id: "panel",
 get ["data-count"]() {
 return color();
 },
 disabled: true
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
 get ["attr:title"]() {
 return color();
 },
 get ["bool:open"]() {
 return active();
 }
 }), () => "static", true);
}