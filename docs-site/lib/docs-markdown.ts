import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readDocsPageMarkdown(slugs: string[]) {
  if (
    slugs.length === 0 ||
    slugs.some((segment) => segment.includes("/") || segment.includes(".."))
  ) {
    throw new Error(`Invalid docs page slug: ${slugs.join("/")}`);
  }

  const docsRoot = join(process.cwd(), "content/docs");
  const directPath = join(docsRoot, `${slugs.join("/")}.mdx`);

  try {
    return await readFile(directPath, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  return readFile(join(docsRoot, slugs.join("/"), "index.mdx"), "utf8");
}

function isNotFoundError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
