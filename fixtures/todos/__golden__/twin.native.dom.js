import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
import { createComponent as _$createComponent } from "@solidjs/web";
import { effect as _$effect } from "@solidjs/web";
import { delegateEvents as _$delegateEvents } from "@solidjs/web";
import { Show as _$Show } from "@solidjs/web";
import { For as _$For } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<ul><!><!>`);
var _tmpl$2 = /* @__PURE__ */ _$template(`<div><input><button>Add`);
var _tmpl$3 = /* @__PURE__ */ _$template(`<p>No todos`);
var _tmpl$4 = /* @__PURE__ */ _$template(`<li>: <!>`);
var _tmpl$5 = /* @__PURE__ */ _$template(`<li>`);
import { createSignal } from "solid-js";
export function Todos() {
 const [todos, setTodos] = createSignal([]);
 const [text, setText] = createSignal("");
 const addTodo = () => {
 setTodos([...todos(), {
 id: todos().length,
 text: text()
 }]);
 setText("");
 };
 var _el$ = _tmpl$2();
 var _el$2 = _el$.firstChild;
 var _el$3 = _el$2.nextSibling;
 _el$2.$$input = (e) => {
 setText(e.currentTarget.value);
 };
 _el$3.$$click = addTodo;
 _$insert(_el$, _$createComponent(_$Show, {
 get when() {
 return todos().length > 0;
 },
 get fallback() {
 return _tmpl$3();
 },
 get children() {
 var _el$4 = _tmpl$();
 var _el$5 = _el$4.firstChild;
 var _el$6 = _el$5.nextSibling;
 _$insert(_el$4, _$createComponent(_$For, {
 get each() {
 return todos();
 },
 keyed: false,
 children: (todo, i) => (() => {
 var _el$8 = _tmpl$4();
 var _el$9 = _el$8.firstChild;
 var _el$10 = _el$9.nextSibling;
 _$insert(_el$8, i, _el$9);
 _$insert(_el$8, () => {
 return todo().text;
 }, _el$10);
 return _el$8;
 })()
 }), _el$5);
 _$insert(_el$4, _$createComponent(_$For, {
 get each() {
 return todos();
 },
 children: (todo, i) => (() => {
 var _el$11 = _tmpl$5();
 _$insert(_el$11, () => {
 return todo.text;
 });
 return _el$11;
 })()
 }), _el$6);
 return _el$4;
 }
 }), null);
 _$effect(() => text(), (_v$) => {
 _el$2.value = _v$ ?? "";
 });
 return _el$;
}
_$delegateEvents(["input", "click"]);
