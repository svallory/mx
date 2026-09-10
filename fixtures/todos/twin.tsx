import { createSignal, For, Show } from "solid-js";

interface Todo {
  id: number;
  text: string;
}

export function Todos() {
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const [text, setText] = createSignal("");

  const addTodo = () => {
    setTodos([...todos(), { id: todos().length, text: text() }]);
    setText("");
  };

  return (
    <div>
      <input value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      <button onClick={addTodo}>Add</button>
      <Show when={todos().length > 0} fallback={<p>No todos</p>}>
        <ul>
          <For each={todos()}>{(todo) => <li>{todo.text}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}
