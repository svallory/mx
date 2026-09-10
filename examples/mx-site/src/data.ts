/** Sample data fed to every page, shared by the dev server and the static build. */
export const pageData = {
  list: {
    fruits: ["apple", "banana", "cherry"],
    tasks: [
      { id: "t1", label: "Write docs" },
      { id: "t2", label: "Ship it" },
    ],
  },
  listEmpty: {
    fruits: [],
    tasks: [],
  },
  form: {
    username: "ada",
    bio: `<script>alert("x & y")</script>`,
    extraAttrs: {
      placeholder: "type here",
      "data-testid": "extra-input",
      "bad>key": "dropped",
      required: true,
      disabled: false,
    },
  },
  mixins: {
    badges: ["new", "hot", "sale"],
  },
  raw: {
    markup: "<b>bold</b> & <i>italic</i>",
  },
};
