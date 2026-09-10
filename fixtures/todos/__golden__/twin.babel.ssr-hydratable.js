import { ssr as _$ssr } from "@solidjs/web";
import { For as _$For } from "@solidjs/web";
import { Show as _$Show } from "@solidjs/web";
import { ssrAttribute as _$ssrAttribute } from "@solidjs/web";
import { escape as _$escape } from "@solidjs/web";
import { ssrHydrationKey as _$ssrHydrationKey } from "@solidjs/web";
var _tmpl$ = ["<ul", "><!--$-->", "<!--/--><!--$-->", "<!--/--></ul>"],
 _tmpl$2 = ["<div", "><input", "><button>Add</button><!--$-->", "<!--/--></div>"],
 _tmpl$3 = ["<p", ">No todos</p>"],
 _tmpl$4 = ["<li", "><!--$-->", "<!--/-->: <!--$-->", "<!--/--></li>"],
 _tmpl$5 = ["<li", ">", "</li>"];
import { createSignal } from "solid-js";
export function Todos() {
 var _v$3, _v$4, _v$5;
 const [todos, setTodos] = createSignal([]);
 const [text, setText] = createSignal("");
 const addTodo = () => {
 setTodos([...todos(), {
 id: todos().length,
 text: text()
 }]);
 setText("");
 };
 var _v$ = _$ssrHydrationKey(),
 _v$6 = _$escape(_$Show({
 get when() {
 return todos().length > 0;
 },
 get fallback() {
 var _v$7 = _$ssrHydrationKey();
 return _$ssr(_tmpl$3, _v$7);
 },
 get children() {
 return _v$3 = _$ssrHydrationKey(), _v$4 = _$escape(_$For({
 get each() {
 return todos();
 },
 keyed: false,
 children: (todo, i) => {
 var _v$8, _v$9, _v$0;
 return _v$8 = _$ssrHydrationKey(), _v$9 = _$escape(i), _v$0 = () => _$escape(todo().text), _$ssr(_tmpl$4, _v$8, _v$9, _v$0);
 }
 })), _v$5 = _$escape(_$For({
 get each() {
 return todos();
 },
 children: (todo, i) => {
 var _v$1, _v$10;
 return _v$1 = _$ssrHydrationKey(), _v$10 = () => _$escape(todo.text), _$ssr(_tmpl$5, _v$1, _v$10);
 }
 })), _$ssr(_tmpl$, _v$3, _v$4, _v$5);
 }
 })),
 _v$2 = () => _$ssrAttribute("value", _$escape(text(), true));
 return _$ssr(_tmpl$2, _v$, _v$2, _v$6);
}