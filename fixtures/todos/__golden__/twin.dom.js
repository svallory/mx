import { template as _$template } from "solid-js/web";
import { delegateEvents as _$delegateEvents } from "solid-js/web";
import { insert as _$insert } from "solid-js/web";
import { createComponent as _$createComponent } from "solid-js/web";
import { effect as _$effect } from "solid-js/web";
var _tmpl$ = /*#__PURE__*/_$template(`<ul>`),
 _tmpl$2 = /*#__PURE__*/_$template(`<div><input><button>Add`),
 _tmpl$3 = /*#__PURE__*/_$template(`<p>No todos`),
 _tmpl$4 = /*#__PURE__*/_$template(`<li>`);
import { createSignal, For, Show } from "solid-js";
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
 return (() => {
 var _el$ = _tmpl$2(),
 _el$2 = _el$.firstChild,
 _el$3 = _el$2.nextSibling;
 _el$2.$$input = e => setText(e.currentTarget.value);
 _el$3.$$click = addTodo;
 _$insert(_el$, _$createComponent(Show, {
 get when() {
 return todos().length > 0;
 },
 get fallback() {
 return _tmpl$3();
 },
 get children() {
 var _el$4 = _tmpl$();
 _$insert(_el$4, _$createComponent(For, {
 get each() {
 return todos();
 },
 children: todo => (() => {
 var _el$6 = _tmpl$4();
 _$insert(_el$6, () => todo.text);
 return _el$6;
 })()
 }));
 return _el$4;
 }
 }), null);
 _$effect(() => _el$2.value = text());
 return _el$;
 })();
}
_$delegateEvents(["input", "click"]);