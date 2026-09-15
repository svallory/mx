import page from "./page.mx";

// The `.mx` module's own `Input` is what types this call, so a discovered tag
// inside the template must not blank out the file's type surface.
export const html: string = page({ title: "hi" });
