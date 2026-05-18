import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      addLanguageClass: true,
      themes: {
        light: "min-light",
        dark: "github-dark",
      },
    },
  },
});
