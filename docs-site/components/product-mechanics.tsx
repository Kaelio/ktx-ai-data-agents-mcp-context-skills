import type { ReactNode } from "react";

type SourceInput = {
  name: string;
  sources: string[];
  detail: string;
  signal: string;
  accent: string;
};

const sourceInputs = [
  {
    name: "Database structure",
    sources: [
      "Postgres",
      "Snowflake",
      "BigQuery",
      "and many others",
    ],
    detail: "tables, columns, types, constraints, row counts",
    signal: "grounds definitions in live database structure",
    accent: "border-fd-primary",
  },
  {
    name: "BI and usage evidence",
    sources: ["Metabase", "Looker"],
    detail: "historic SQL, questions, dashboards, usage patterns",
    signal: "extracts joins, filters, grain, and trusted examples",
    accent: "border-orange-500",
  },
  {
    name: "Semantic modeling",
    sources: ["dbt", "MetricFlow", "LookML"],
    detail: "models, metrics, dimensions, explores, joins",
    signal: "maps existing modeling logic into semantic entities",
    accent: "border-amber-500",
  },
  {
    name: "Company documentation",
    sources: ["Notion"],
    detail: "Notion pages, policies, caveats",
    signal: "links business language back to semantic references",
    accent: "border-slate-500 dark:border-cyan-200",
  },
] satisfies SourceInput[];

const ingestSteps = [
  {
    title: "extract evidence",
    body: "Pull structured facts from schemas, SQL, BI metadata, and docs.",
  },
  {
    title: "reconcile entities",
    body: "Merge names, measures, joins, and caveats into one project model.",
  },
  {
    title: "validate references",
    body: "Check semantic fields and joins against database context before agents use them.",
  },
];

const artifacts = [
  {
    path: "semantic-layer/*.yaml",
    title: "Typed query model",
    body: "sources, grain, joins, dimensions, measures, filters, segments",
  },
  {
    path: "wiki/*.md",
    title: "Business context",
    body: "rules and caveats with sl_refs back to semantic-layer entities",
  },
  {
    path: "raw-sources/",
    title: "Evidence trail",
    body: "scan artifacts, extracted metadata, relationship evidence",
  },
  {
    path: ".ktx/",
    title: "Local indexes",
    body: "embeddings and search indexes, not the source of truth",
  },
];

const runtimeSteps = [
  {
    title: "Search wiki",
    body: "Find business rules, caveats, synonyms, and sl_refs.",
  },
  {
    title: "Resolve semantic refs",
    body: "Map measure and dimension names to approved entities.",
  },
  {
    title: "Validate fields",
    body: "Check source, columns, joins, grain, filters, and segments.",
  },
  {
    title: "Build query plan",
    body: "Create a semantic query plan before SQL is generated.",
  },
  {
    title: "Compile dialect SQL",
    body: "Generate warehouse-shaped SQL instead of copying examples.",
  },
  {
    title: "Execute with bounds",
    body: "Optionally run with bounded rows and return provenance.",
  },
];

export function ProductMechanics() {
  return (
    <section
      className="not-prose my-12 w-full max-w-full min-w-0 space-y-5"
      aria-labelledby="mechanics-title"
    >
      <div className="max-w-3xl">
        <h2
          id="mechanics-title"
          className="text-xl font-semibold tracking-normal text-fd-foreground sm:text-2xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          How KTX works
        </h2>
        <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
          KTX reads source evidence, writes local context files, and gives
          agents semantic search, validation, SQL, and provenance.
        </p>
      </div>

      <div className="space-y-4">
        <IngestionDiagram />
        <RuntimeDiagram />
      </div>
    </section>
  );
}

function IngestionDiagram() {
  return (
    <article
      className="max-w-full min-w-0 overflow-hidden rounded-lg border border-fd-border bg-fd-card shadow-sm"
      aria-labelledby="ingestion-diagram-title"
    >
      <DiagramHeader
        eyebrow="Ingestion"
        id="ingestion-diagram-title"
        title="Build context from source evidence"
        body="KTX reconciles loose metadata, SQL, BI usage, and documentation into files agents can validate and edit."
      />

      <div className="grid gap-0 lg:grid-cols-[minmax(0,0.94fr)_minmax(0,1.06fr)]">
        <section className="flex flex-col border-b border-fd-border p-4 lg:border-r lg:border-b-0">
          <ColumnLabel>Inputs KTX reads</ColumnLabel>
          <div className="grid flex-1 auto-rows-fr gap-2">
            {sourceInputs.map((source) => (
              <div
                key={source.name}
                className={`grid min-h-0 gap-2 border-l-2 bg-fd-background px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(6.5rem,0.42fr)] sm:items-center ${source.accent}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-fd-foreground">
                    {source.name}
                  </p>
                  <p className="mt-0.5 text-xs leading-4 text-fd-muted-foreground">
                    {source.detail}
                  </p>
                  <p className="mt-1 text-xs leading-4 text-fd-primary">
                    {source.signal}
                  </p>
                </div>
                <SourceList sources={source.sources} />
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col bg-fd-muted/35 p-4">
          <ColumnLabel>KTX transforms evidence</ColumnLabel>
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-fd-border bg-[#102226] p-3 text-white dark:bg-[#0b181b]">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-cyan-200">
                KTX builds the model
              </p>
              <ol className="grid gap-3">
                {ingestSteps.map((step, index) => (
                  <PipelineStep
                    key={step.title}
                    index={index + 1}
                    title={step.title}
                    body={step.body}
                    dark
                  />
                ))}
              </ol>
            </div>

            <div className="border-t border-fd-border/80 pt-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fd-muted-foreground">
                Outputs KTX writes
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {artifacts.map((artifact) => (
                  <Artifact key={artifact.path} {...artifact} />
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </article>
  );
}

function RuntimeDiagram() {
  return (
    <article
      className="max-w-full min-w-0 overflow-hidden rounded-lg border border-fd-border bg-fd-card shadow-sm"
      aria-labelledby="runtime-diagram-title"
    >
      <DiagramHeader
        eyebrow="Runtime"
        id="runtime-diagram-title"
        title="Run agent requests through the model"
        body="Agents send business intent. KTX resolves fields, checks joins and grain, compiles SQL, and can execute with row limits."
      />

      <div className="grid gap-0 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
        <section className="border-b border-fd-border p-4 lg:border-r lg:border-b-0">
          <ColumnLabel>Agent sends</ColumnLabel>
          <CodeBox>
            <div>connection: warehouse</div>
            <div>measure: orders.total_revenue</div>
            <div>dimension: customers.segment</div>
            <div>filter: orders.created_date &gt;= '2024-01-01'</div>
          </CodeBox>
          <p className="mt-3 text-xs leading-5 text-fd-muted-foreground">
            This is the API surface agents should use: compact semantic intent,
            not hand-written warehouse SQL.
          </p>
        </section>

        <section className="bg-fd-muted/35 p-4">
          <ColumnLabel>KTX planning and execution</ColumnLabel>
          <ol className="grid gap-2 sm:grid-cols-2">
            {runtimeSteps.map((step, index) => (
              <PipelineStep
                key={step.title}
                index={index + 1}
                title={step.title}
                body={step.body}
              />
            ))}
          </ol>
        </section>
      </div>

      <div className="grid gap-0 border-t border-fd-border lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="border-b border-fd-border p-4 lg:border-r lg:border-b-0">
          <ColumnLabel>Semantic query plan</ColumnLabel>
          <div className="rounded-md border border-fd-border bg-fd-card p-3 text-xs leading-5 text-fd-muted-foreground">
            <p>
              <strong className="text-fd-foreground">source:</strong>{" "}
              orders joined to customers as many_to_one
            </p>
            <p>
              <strong className="text-fd-foreground">measure:</strong>{" "}
              total_revenue = sum(amount) with refund filter
            </p>
            <p>
              <strong className="text-fd-foreground">grain:</strong> segment
              group-by with date predicate
            </p>
            <p>
              <strong className="text-fd-foreground">result:</strong> dialect
              SQL, bounded rows, and provenance
            </p>
          </div>
        </section>

        <section className="p-4">
          <ColumnLabel>KTX returns</ColumnLabel>
          <CodeBox>
            <div>select</div>
            <div className="pl-3">customers.segment,</div>
            <div className="pl-3">sum(orders.amount) as total_revenue</div>
            <div>from analytics.orders</div>
            <div>join analytics.customers</div>
            <div className="pl-3">on orders.customer_id = customers.id</div>
            <div>where orders.status != 'refunded'</div>
            <div className="pl-3">and orders.created_date &gt;= '2024-01-01'</div>
            <div>group by 1</div>
          </CodeBox>
          <p className="mt-3 text-xs leading-5 text-fd-muted-foreground">
            The output can be SQL-only or executed results with provenance, so
            the agent can show where the answer came from.
          </p>
        </section>
      </div>
    </article>
  );
}

function DiagramHeader({
  body,
  eyebrow,
  id,
  title,
}: {
  body: string;
  eyebrow: string;
  id: string;
  title: string;
}) {
  return (
    <div className="border-b border-fd-border bg-fd-muted/35 px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-fd-primary">
        {eyebrow}
      </p>
      <h3
        id={id}
        className="mt-1 text-base font-semibold tracking-normal text-fd-foreground sm:text-lg"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {title}
      </h3>
      <p className="mt-2 max-w-3xl text-xs leading-5 text-fd-muted-foreground">
        {body}
      </p>
    </div>
  );
}

function Artifact({
  body,
  path,
  title,
}: {
  body: string;
  path: string;
  title: string;
}) {
  return (
    <div className="rounded-md border border-fd-border bg-fd-card px-3 py-2">
      <p className="font-mono text-xs font-semibold text-fd-foreground">
        {path}
      </p>
      <p className="mt-1 text-sm font-semibold text-fd-foreground">{title}</p>
      <p className="mt-0.5 text-xs leading-5 text-fd-muted-foreground">
        {body}
      </p>
    </div>
  );
}

function PipelineStep({
  body,
  dark = false,
  index,
  title,
}: {
  body: string;
  dark?: boolean;
  index: number;
  title: string;
}) {
  return (
    <li
      className={
        dark
          ? "flex gap-3 text-sm"
          : "flex gap-3 rounded-md border border-fd-border bg-fd-card px-3 py-2"
      }
    >
      <span
        className={
          dark
            ? "flex h-5 w-5 flex-none items-center justify-center rounded-full bg-cyan-200 text-[11px] font-semibold text-[#102226]"
            : "flex h-5 w-5 flex-none items-center justify-center rounded-full bg-fd-primary text-[11px] font-semibold text-fd-primary-foreground"
        }
      >
        {index}
      </span>
      <span className="min-w-0">
        <span
          className={
            dark
              ? "block text-sm font-semibold text-white"
              : "block text-xs font-semibold text-fd-foreground"
          }
        >
          {title}
        </span>
        <span
          className={
            dark
            ? "mt-0.5 block break-words text-xs leading-5 text-cyan-50/75"
              : "mt-0.5 block break-words text-xs leading-5 text-fd-muted-foreground"
          }
        >
          {body}
        </span>
      </span>
    </li>
  );
}

function ColumnLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-fd-muted-foreground">
      {children}
    </p>
  );
}

function SourceList({
  sources,
}: {
  sources: string[];
}) {
  return (
    <div
      className="min-w-0 border-t border-fd-border/70 pt-2 sm:border-t-0 sm:border-l sm:pl-3 sm:pt-0"
      aria-label="Sources"
    >
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-fd-muted-foreground/80">
        Sources
      </p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((source) =>
          source === "and many others" ? (
            <span
              key={source}
              className="px-0.5 py-0.5 text-[10px] font-medium leading-4 text-fd-muted-foreground/85"
            >
              {source}
            </span>
          ) : (
            <span
              key={source}
              className="rounded border border-fd-border bg-fd-card/75 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-fd-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
            >
              {source}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

function CodeBox({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-full min-w-0 overflow-x-auto rounded-md border border-fd-border bg-[#0c1417] p-3 font-mono text-[11px] leading-5 text-cyan-50 shadow-sm">
      <div className="[overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}
