import { Hono } from "hono";
import App from "./App.mx";

const app = new Hono();

app.get("/", async (c) => {
  const element = App({ items: ["alpha", "beta", "gamma"] });
  const html = await element.toString();
  return c.html(html);
});

const port = Number(process.env.PORT ?? 5174);
console.log(`hono-app listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
