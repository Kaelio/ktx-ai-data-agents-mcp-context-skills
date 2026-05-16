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
  const whyIndex = introduction.indexOf("## Why KTX");
  const createsIndex = introduction.indexOf("## What KTX creates");
  const mechanicsIndex = introduction.indexOf("<ProductMechanics />");
  const useCaseIndex = introduction.indexOf("## Use it for");
  const heroSource = introduction.slice(0, mechanicsIndex);

  assert.ok(heroIndex >= 0, "introduction should include the custom hero");
  assert.ok(
    whyIndex > heroIndex,
    "problem framing should appear after the hero",
  );
  assert.ok(
    createsIndex > whyIndex,
    "artifact summary should appear after problem framing",
  );
  assert.ok(
    mechanicsIndex > createsIndex,
    "mechanics component should appear after the artifact summary",
  );
  assert.ok(
    mechanicsIndex < useCaseIndex,
    "mechanics component should appear before use-case sections",
  );
  assert.doesNotMatch(heroSource, /Get Started/);
  assert.doesNotMatch(heroSource, /The Context Layer/);
  assert.doesNotMatch(heroSource, /Building Context/);
  assert.doesNotMatch(heroSource, /flex flex-wrap gap-3/);
});

test("product mechanics component covers source-specific context and SQL expansion", async () => {
  const component = await readDocsFile("components/product-mechanics.tsx");

  for (const expectedText of [
    "How KTX works",
    "Build context from source evidence",
    "Run agent requests through the model",
    "Ingestion",
    "Runtime",
    "wiki/",
    "semantic-layer/",
    "raw-sources/",
    ".ktx/",
    "sl_refs",
    "Database structure",
    "BI and usage evidence",
    "Semantic modeling",
    "Company documentation",
    "Notion pages",
    "Sources",
    "KTX transforms evidence",
    "KTX builds the model",
    "Outputs KTX writes",
    "Postgres",
    "Snowflake",
    "BigQuery",
    "and many others",
    "Metabase",
    "Looker",
    "MetricFlow",
    "LookML",
    "extract evidence",
    "reconcile entities",
    "validate references",
    "semantic query plan",
    "dialect SQL",
    "bounded rows",
    "provenance",
    "measure: orders.total_revenue",
    "dimension: customers.segment",
    "select",
  ]) {
    assert.ok(
      component.includes(expectedText),
      `component should include: ${expectedText}`,
    );
  }

  assert.doesNotMatch(component, /Product mechanics/);
  assert.doesNotMatch(component, /A semantic compiler for analytics agents/);
  assert.doesNotMatch(component, /KTX does more than retrieve Markdown/);
  assert.doesNotMatch(component, /Plain Markdown \+ RAG/);
  assert.doesNotMatch(component, /comparisonRows/);
  assert.doesNotMatch(component, /ComparisonTable/);
  assert.doesNotMatch(component, /Not just retrieval/);
  assert.doesNotMatch(component, /KTX works in two moments/);
  assert.doesNotMatch(component, /name: "Metabase and query history"/);
  assert.doesNotMatch(component, /name: "dbt, MetricFlow, LookML"/);
  assert.doesNotMatch(component, /query history/);
  assert.doesNotMatch(component, /analyst notes/);
  assert.doesNotMatch(component, /ClickHouse/);
  assert.doesNotMatch(component, /MySQL/);
  assert.doesNotMatch(component, /SQL Server/);
  assert.doesNotMatch(component, /SQLite/);
  assert.doesNotMatch(
    component,
    /\/ktx\/brand\/(?:postgresql|snowflake|bigquery|clickhouse|mysql|sqlserver|sqlite|metabase|dbt|looker|notion)\.svg/,
  );
  assert.doesNotMatch(component, /<img/);
  assert.doesNotMatch(component, /w-\[calc\(100vw/);
  assert.doesNotMatch(component, /xl:grid-cols-2/);
  assert.doesNotMatch(component, /lg:grid-cols-\[[^\]]*_2rem_/);
});
