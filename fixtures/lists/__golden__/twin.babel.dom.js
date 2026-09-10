import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
import { Repeat as _$Repeat } from "@solidjs/web";
import { createComponent as _$createComponent } from "@solidjs/web";
import { For as _$For } from "@solidjs/web";
var _tmpl$ = /*#__PURE__*/_$template(`<div><!><!><!><!><!>`),
 _tmpl$2 = /*#__PURE__*/_$template(`<li>: <!>`),
 _tmpl$3 = /*#__PURE__*/_$template(`<li>`),
 _tmpl$4 = /*#__PURE__*/_$template(`<span>`),
 _tmpl$5 = /*#__PURE__*/_$template(`<b>`),
 _tmpl$6 = /*#__PURE__*/_$template(`<p>=<!>`);
import { createSignal } from "solid-js";
export function Lists() {
 // Setters are unused: the fixture exercises lowering shapes, not behavior.
 const [rows, _setRows] = createSignal([]);
 const [count, _setCount] = createSignal(3);
 const [meta, _setMeta] = createSignal({});
 var _el$ = _tmpl$(),
 _el$2 = _el$.firstChild,
 _el$3 = _el$2.nextSibling,
 _el$4 = _el$3.nextSibling,
 _el$5 = _el$4.nextSibling,
 _el$6 = _el$5.nextSibling;
 _$insert(_el$, _$createComponent(_$For, {
 get each() {
 return rows();
 },
 keyed: x => x.id,
 children: (row, i) => (() => {
 var _el$7 = _tmpl$2(),
 _el$8 = _el$7.firstChild,
 _el$9 = _el$8.nextSibling;
 _$insert(_el$7, i, _el$8);
 _$insert(_el$7, () => row().label, _el$9);
 return _el$7;
 })()
 }), _el$2);
 _$insert(_el$, _$createComponent(_$For, {
 get each() {
 return rows();
 },
 keyed: r => r.label,
 children: (row, i) => (() => {
 var _el$0 = _tmpl$3();
 _$insert(_el$0, () => row().label);
 return _el$0;
 })()
 }), _el$3);
 _$insert(_el$, _$createComponent(_$Repeat, {
 get count() {
 return count() - 1 + 1;
 },
 from: 1,
 children: i => (() => {
 var _el$1 = _tmpl$4();
 _$insert(_el$1, i);
 return _el$1;
 })()
 }), _el$4);
 _$insert(_el$, _$createComponent(_$Repeat, {
 count: 4,
 children: i => (() => {
 var _el$10 = _tmpl$5();
 _$insert(_el$10, i);
 return _el$10;
 })()
 }), _el$5);
 _$insert(_el$, _$createComponent(_$For, {
 get each() {
 return Object.entries(meta());
 },
 keyed: e => e[0],
 children: ([k, v]) => (() => {
 var _el$11 = _tmpl$6(),
 _el$12 = _el$11.firstChild,
 _el$13 = _el$12.nextSibling;
 _$insert(_el$11, k, _el$12);
 _$insert(_el$11, v, _el$13);
 return _el$11;
 })()
 }), _el$6);
 return _el$;
}