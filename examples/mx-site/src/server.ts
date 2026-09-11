import { Hono } from "hono";
import { pageData } from "./data.ts";
import renderForm from "./pages/form.mx";
import renderIndex from "./pages/index.mx";
import renderList from "./pages/list.mx";
import renderMixins from "./pages/mixins.mx";
import renderRaw from "./pages/raw.mx";

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
