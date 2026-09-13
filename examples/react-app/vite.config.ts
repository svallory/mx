import mx from "@mxlang/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// MX runs first and turns `.mx` into React TSX; the React plugin then applies
// the same JSX transform and Fast Refresh integration as it does to `.tsx`.
export default defineConfig({
  plugins: [mx(), react()],
});
