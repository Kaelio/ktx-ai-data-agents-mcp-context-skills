import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const docsSiteDir = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readDocsFile(path) {
  return readFile(join(docsSiteDir, path), "utf8");
}

test("docs introduction frames the concept before showing product mechanics", async () => {
  const introduction = await readDocsFile(
    "content/docs/getting-started/introduction.mdx",
  );

  assert.match(
    introduction,
    /import\s+\{\s*ProductMechanics\s*\}\s+from\s+"@\/components\/product-mechanics";/,
  );
  assert.match(introduction, /<ProductMechanics\s*\/>/);

  const heroIndex = introduction.indexOf("Make analytics context");
  const whyIndex = introduction.indexOf("## Why ktx helps");
  const worksIndex = introduction.indexOf("## How ktx works");
  const mechanicsIndex = introduction.indexOf("<ProductMechanics />");
  const useCaseIndex = introduction.indexOf("## Use it for");
  const heroSource = introduction.slice(0, mechanicsIndex);

  assert.ok(heroIndex >= 0, "introduction should include the custom hero");
  assert.ok(
    whyIndex > heroIndex,
    "problem framing should appear after the hero",
  );
  assert.ok(
    worksIndex > whyIndex,
    "mechanics bridge should appear after problem framing",
  );
  assert.ok(
    mechanicsIndex > worksIndex,
    "mechanics component should appear after the mechanics bridge",
  );
  assert.ok(
    mechanicsIndex < useCaseIndex,
    "mechanics component should appear before use-case sections",
  );
  assert.doesNotMatch(heroSource, /Get Started/);
  assert.doesNotMatch(heroSource, /The Context Layer/);
  assert.doesNotMatch(heroSource, /Building Context/);
  assert.doesNotMatch(heroSource, /flex flex-wrap gap-3/);
  assert.doesNotMatch(introduction, /raw-sources/);
  assert.doesNotMatch(introduction, /\.ktx/);
});

test("product mechanics component explains ingestion outputs", async () => {
  const component = await readDocsFile("components/product-mechanics.tsx");

  for (const expectedText of [
    "How ingestion works",
    "Ingestion flow",
    "From scattered source systems to agent-ready context",
    "wiki/*.md",
    "semantic-layer/*.yaml",
    "Wiki",
    "Semantic layer",
    "Databases",
    "BI tools",
    "Modeling code",
    "Docs and notes",
    "Source connectors",
    "Context builder",
    "Reconciliation",
    "Validation",
    "PostgreSQL",
    "Snowflake",
    "BigQuery",
    "Metabase",
    "Looker",
    "dbt",
    "MetricFlow",
    "LookML",
    "Notion",
    "Any text",
    "compile into SQL",
    '"use client"',
    "@xyflow/react",
    "<ReactFlow",
    "getSmoothStepPath",
    "animateMotion",
    "mechanics-particle",
    "buildParticlePath",
  ]) {
    assert.ok(
      component.includes(expectedText),
      `component should include: ${expectedText}`,
    );
  }

  assert.match(
    component,
    /nodesDraggable=\{false\}/,
    "ReactFlow canvas should disable node dragging",
  );
  assert.match(
    component,
    /panOnDrag=\{false\}/,
    "ReactFlow canvas should disable panning",
  );
  assert.match(
    component,
    /zoomOnScroll=\{false\}/,
    "ReactFlow canvas should disable scroll zoom",
  );

  assert.doesNotMatch(component, /raw-sources/);
  assert.doesNotMatch(component, /\.ktx/);
  assert.doesNotMatch(component, /Product mechanics/);
  assert.doesNotMatch(component, /How ktx works/);
  assert.doesNotMatch(component, /Runtime/);
  assert.doesNotMatch(component, /A semantic compiler for analytics agents/);
  assert.doesNotMatch(component, /ktx does more than retrieve Markdown/);
  assert.doesNotMatch(component, /Plain Markdown \+ RAG/);
  assert.doesNotMatch(component, /comparisonRows/);
  assert.doesNotMatch(component, /ComparisonTable/);
  assert.doesNotMatch(component, /Not just retrieval/);
  assert.doesNotMatch(component, /ktx works in two moments/);
  assert.doesNotMatch(component, /name: "Metabase and query history"/);
  assert.doesNotMatch(component, /name: "dbt, MetricFlow, LookML"/);
  assert.doesNotMatch(component, /MySQL/);
  assert.doesNotMatch(component, /SQL Server/);
  assert.doesNotMatch(
    component,
    /\/ktx\/brand\/(?:postgresql|snowflake|bigquery|mysql|sqlserver|sqlite|metabase|dbt|looker|notion)\.svg/,
  );
  assert.doesNotMatch(component, /<img/);
  assert.doesNotMatch(component, /w-\[calc\(100vw/);
  assert.doesNotMatch(component, /xl:grid-cols-2/);
  assert.doesNotMatch(component, /lg:grid-cols-\[[^\]]*_2rem_/);
});
