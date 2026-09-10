import { render } from "@solidjs/web";
import "todomvc-common/base.css";
import "todomvc-app-css/index.css";
import { App } from "./App.solid.mx";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

render(() => <App />, root);
