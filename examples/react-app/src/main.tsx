import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.mx";

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
