import { Hono } from "hono";
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

const app = new Hono();

app.get("/", (c) => c.html(renderIndex({})));
app.get("/list", (c) => c.html(renderList(pageData.list)));
app.get("/list-empty", (c) => c.html(renderList(pageData.listEmpty)));
app.get("/form", (c) => c.html(renderForm(pageData.form)));
app.get("/mixins", (c) => c.html(renderMixins(pageData.mixins)));
app.get("/raw", (c) => c.html(renderRaw(pageData.raw)));

const port = Number(process.env.PORT ?? 5173);
console.log(`mx-site listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
