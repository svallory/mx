import mx from "@mx/vite-plugin";
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

// `mx()` must come first: both plugins are `enforce: "pre"`, so their relative
// order is their order in this array. MX prints `.solid.mx` to JSX source text,
// then Solid's plugin compiles that with its default native compiler.
export default defineConfig({
  plugins: [mx(), solid()],
});
