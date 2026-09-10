import { ssr as _$ssr } from "solid-js/web";
import { createComponent as _$createComponent } from "solid-js/web";
import { For as _$For } from "solid-js/web";
import { Show as _$Show } from "solid-js/web";
import { ssrAttribute as _$ssrAttribute } from "solid-js/web";
import { escape as _$escape } from "solid-js/web";
import { ssrHydrationKey as _$ssrHydrationKey } from "solid-js/web";
var _tmpl$ = ["<ul", ">", "</ul>"],
 _tmpl$2 = ["<div", "><input", "><button>Add</button><!--$-->", "<!--/--></div>"],
 _tmpl$3 = ["<p", ">No todos</p>"],
 _tmpl$4 = ["<li", ">", "</li>"];
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
 return _$ssr(_tmpl$2, _$ssrHydrationKey(), _$ssrAttribute("value", _$escape(text(), true), false), _$escape(_$createComponent(_$Show, {
 get when() {
 return todos().length > 0;
 },
 get fallback() {
 return _$ssr(_tmpl$3, _$ssrHydrationKey());
 },
 get children() {
 return _$ssr(_tmpl$, _$ssrHydrationKey(), _$escape(_$createComponent(_$For, {
 get each() {
 return todos();
 },
 children: (todo, i) => _$ssr(_tmpl$4, _$ssrHydrationKey(), _$escape(todo.text))
 })));
 }
 })));
}