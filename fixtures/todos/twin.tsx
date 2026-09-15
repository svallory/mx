import { createSignal } from "solid-js";

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
      <input
        value={text()}
        onInput={(e) => {
          setText(e.currentTarget.value);
        }}
      />
      <button onClick={addTodo}>Add</button>
      <Show when={todos().length > 0} fallback={<p>No todos</p>}>
        <ul>
          {/* default keyed form (no by=): item is the raw row value, index an accessor */}
          <For each={todos()}>
            {(todo, i) => (
              <li>
                {i()}: {todo.text}
              </li>
            )}
          </For>
          {/* identity-keyed (by=identity, same lowering as the default above) */}
          {/* biome-ignore lint/correctness/noUnusedFunctionParameters: mirrors the MX `<for|todo, i|>` param list */}
          <For each={todos()}>{(todo, i) => <li>{todo.text}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}
