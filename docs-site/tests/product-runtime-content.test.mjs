import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const docsSiteDir = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readDocsFile(path) {
  return readFile(join(docsSiteDir, path), "utf8");
}

test("docs introduction renders the serving phase after ingestion", async () => {
  const introduction = await readDocsFile(
    "content/docs/getting-started/introduction.mdx",
  );

  assert.match(
    introduction,
    /import\s+\{\s*ProductRuntime\s*\}\s+from\s+"@\/components\/product-runtime";/,
  );
  assert.match(introduction, /<ProductRuntime\s*\/>/);

  const mechanicsIndex = introduction.indexOf("<ProductMechanics />");
  const runtimeIndex = introduction.indexOf("<ProductRuntime />");
  const useCaseIndex = introduction.indexOf("## Use it for");

  assert.ok(
    runtimeIndex > mechanicsIndex,
    "serving diagram should appear after the ingestion diagram",
  );
  assert.ok(
    runtimeIndex < useCaseIndex,
    "serving diagram should appear before use-case sections",
  );
});

test("product runtime component explains the serving cycle", async () => {
  const component = await readDocsFile("components/product-runtime.tsx");

  for (const expectedText of [
    "How serving works",
    "Serving flow",
    "From an agent request to a governed answer",
    "Your agent",
    "Claude Code",
    "Cursor",
    "Codex",
    "Search wiki + semantic layer",
    "Return approved metrics",
    "Compile metrics → SQL",
    "Context layer",
    "Database",
    "search + read",
    "read-only",
    "wiki/*.md",
    "semantic-layer/*.yaml",
    '"use client"',
    "@xyflow/react",
    "FlowCanvas",
    "getSmoothStepPath",
    "animateMotion",
    "runtime-particle",
    "buildCyclePath",
  ]) {
    assert.ok(
      component.includes(expectedText),
      `component should include: ${expectedText}`,
    );
  }

  assert.doesNotMatch(component, /raw-sources/);
  assert.doesNotMatch(component, /<img/);
});
