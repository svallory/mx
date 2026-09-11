import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pageData } from "./data.ts";
import renderForm from "./pages/form.marko";
import renderIndex from "./pages/index.marko";
import renderList from "./pages/list.marko";
import renderMixins from "./pages/mixins.marko";
import renderRaw from "./pages/raw.marko";

const routes: Record<string, string> = {
  "index.html": renderIndex({}),
  "list.html": renderList(pageData.list),
  "list-empty.html": renderList(pageData.listEmpty),
  "form.html": renderForm(pageData.form),
  "mixins.html": renderMixins(pageData.mixins),
  "raw.html": renderRaw(pageData.raw),
};

const outDir = join(import.meta.dirname, "..", "dist");
mkdirSync(outDir, { recursive: true });

for (const [name, html] of Object.entries(routes)) {
  writeFileSync(join(outDir, name), html);
  console.log(`wrote dist/${name}`);
}
