import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compilePages, loadPage } from "./compile-pages.ts";
import { pageData } from "./data.ts";
import type {
  FormInput,
  IndexInput,
  ListInput,
  MixinsInput,
  RawInput,
} from "./page-types.ts";

compilePages();

const [renderIndex, renderList, renderForm, renderMixins, renderRaw] =
  await Promise.all([
    loadPage<IndexInput>("index"),
    loadPage<ListInput>("list"),
    loadPage<FormInput>("form"),
    loadPage<MixinsInput>("mixins"),
    loadPage<RawInput>("raw"),
  ]);

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
