"use client";

import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type LaneVariant = "manual" | "ktx";

type AgentNodeData = {
  variant: "single";
  title: string;
  subtitle: string;
};

type ManualSqlNodeData = {
  variant: "manual";
  badge: string;
  title: string;
  caption: string;
  code: string;
  notes: string[];
};

type SlQueryNodeData = {
  variant: "slQuery";
  badge: string;
  title: string;
  caption: string;
  code: string;
};

type EngineNodeData = {
  variant: "engine";
  badge: string;
  title: string;
  stages: Array<{ index: number; title: string; detail: string }>;
};

type CompiledSqlNodeData = {
  variant: "compiled";
  badge: string;
  title: string;
  caption: string;
  code: string;
  notes: string[];
};

type WarehouseNodeData = {
  variant: "warehouse";
  title: string;
  drivers: string[];
};

type AgentNode = Node<AgentNodeData, "agent">;
type ManualSqlNode = Node<ManualSqlNodeData, "manualSql">;
type SlQueryNode = Node<SlQueryNodeData, "slQuery">;
type EngineNode = Node<EngineNodeData, "engine">;
type CompiledSqlNode = Node<CompiledSqlNodeData, "compiledSql">;
type WarehouseNode = Node<WarehouseNodeData, "warehouse">;

type FlowNode =
  | AgentNode
  | ManualSqlNode
  | SlQueryNode
  | EngineNode
  | CompiledSqlNode
  | WarehouseNode;

const CANVAS_W = 1120;

const AGENT_W = 380;
const AGENT_H = 104;
const AGENT_X = (CANVAS_W - AGENT_W) / 2;
const AGENT_Y = 16;

const LANE_W = 488;
const LEFT_LANE_X = 32;
const RIGHT_LANE_X = CANVAS_W - LEFT_LANE_X - LANE_W;

const LANE_TOP_Y = 248;

const SL_QUERY_H = 510;
const ENGINE_H = 380;
const COMPILED_H = 1380;
const RIGHT_GAP = 24;

const RIGHT_LANE_TOTAL = SL_QUERY_H + RIGHT_GAP + ENGINE_H + RIGHT_GAP + COMPILED_H;
const MANUAL_SQL_H = 840;
const LANES_BOTTOM_Y =
  LANE_TOP_Y + Math.max(MANUAL_SQL_H, RIGHT_LANE_TOTAL);

const SL_QUERY_Y = LANE_TOP_Y;
const ENGINE_Y = SL_QUERY_Y + SL_QUERY_H + RIGHT_GAP;
const COMPILED_Y = ENGINE_Y + ENGINE_H + RIGHT_GAP;

const WAREHOUSE_W = 304;
const WAREHOUSE_H = 92;
const WAREHOUSE_X = (CANVAS_W - WAREHOUSE_W) / 2;
const WAREHOUSE_Y = LANES_BOTTOM_Y + 56;

const MANUAL_STROKE = "#94a3b8";
const KTX_STROKE = "#0891b2";

const agent: AgentNode = {
  id: "agent",
  type: "agent",
  position: { x: AGENT_X, y: AGENT_Y },
  data: {
    variant: "single",
    title: "Analytics agent",
    subtitle:
      "Asks: monthly net revenue and open tickets per segment, high-value orders only, no test customers",
  },
  draggable: false,
  selectable: false,
};

const manualSql: ManualSqlNode = {
  id: "manual-sql",
  type: "manualSql",
  position: { x: LEFT_LANE_X, y: LANE_TOP_Y },
  data: {
    variant: "manual",
    badge: "Without KTX",
    title: "Agent writes the SQL",
    caption:
      "Stitches four tables, mixes grains, and ships numbers that won't match the dashboard.",
    code: `-- agent stitches four tables, mixes facts,
-- and ships numbers that won't match the dashboard

SELECT
  c.segment,
  DATE_TRUNC('month', o.created_at)  AS month,
  SUM(o.amount) - SUM(r.amount)      AS net_revenue,
  COUNT(t.id)                        AS open_tickets
FROM customers c
LEFT JOIN orders  o
  ON o.customer_id = c.id
LEFT JOIN refunds r
  ON r.order_id = o.id
LEFT JOIN tickets t
  ON t.customer_id = c.id
WHERE
  c.is_test = false
  AND o.amount >= 100
  AND t.status = 'open'     -- turns LEFT JOIN into INNER
GROUP BY
  c.segment,
  DATE_TRUNC('month', o.created_at)
ORDER BY
  month,
  c.segment
LIMIT 1000;

-- chasm trap: orders rows multiply by tickets and refunds
-- net_revenue and open_tickets are both inflated
-- DATE_TRUNC syntax breaks on BigQuery`,
    notes: [
      "Re-stitches a 4-way join on every question",
      "Reinvents net_revenue and the high-value rule",
      "Hides a chasm trap across three facts",
      "Filters a LEFT JOIN target in WHERE",
      "Hardcodes one warehouse's date functions",
    ],
  },
  draggable: false,
  selectable: false,
};

const slQuery: SlQueryNode = {
  id: "sl-query",
  type: "slQuery",
  position: { x: RIGHT_LANE_X, y: SL_QUERY_Y },
  data: {
    variant: "slQuery",
    badge: "With KTX",
    title: "Agent sends a Semantic Query",
    caption:
      "Names the measures, dimensions, segments, and filters it wants. No SQL, no joins.",
    code: `{
  "measures": [
    "orders.revenue",
    "refunds.amount",
    "tickets.open_count",
    {
      "name": "net_revenue",
      "expr": "orders.revenue - refunds.amount"
    }
  ],
  "dimensions": [
    "customers.segment",
    { "field": "orders.created_at", "granularity": "month" }
  ],
  "segments": ["orders.high_value"],
  "filters": ["customers.is_test = false"],
  "limit": 1000
}`,
  },
  draggable: false,
  selectable: false,
};

const engine: EngineNode = {
  id: "engine",
  type: "engine",
  position: { x: RIGHT_LANE_X, y: ENGINE_Y },
  data: {
    variant: "engine",
    badge: "Semantic-layer engine",
    title: "Plans the query against the reviewed graph",
    stages: [
      {
        index: 1,
        title: "Resolve refs",
        detail: "qualify columns, look up measure formulas",
      },
      {
        index: 2,
        title: "Build join tree",
        detail: "Dijkstra over typed edges from an anchor source",
      },
      {
        index: 3,
        title: "Detect fan-out",
        detail: "group measures by source, flag chasm traps",
      },
      {
        index: 4,
        title: "Localize aggregation",
        detail: "pre-aggregate each fact as its own CTE",
      },
      {
        index: 5,
        title: "Transpile dialect",
        detail: "emit Postgres-shaped SQL, then target dialect",
      },
    ],
  },
  draggable: false,
  selectable: false,
};

const compiledSql: CompiledSqlNode = {
  id: "compiled-sql",
  type: "compiledSql",
  position: { x: RIGHT_LANE_X, y: COMPILED_Y },
  data: {
    variant: "compiled",
    badge: "Generated SQL",
    title: "KTX returns dialect-correct SQL",
    caption:
      "Pre-aggregates each fact at its own grain, then joins back on the shared dimension.",
    code: `WITH orders_agg AS (
  SELECT
    customer_id,
    DATE_TRUNC('month', created_at) AS month,
    SUM(amount) AS revenue
  FROM public.orders
  WHERE amount >= 100
  GROUP BY
    customer_id,
    DATE_TRUNC('month', created_at)
),
refunds_agg AS (
  SELECT
    o.customer_id,
    DATE_TRUNC('month', o.created_at) AS month,
    SUM(r.amount) AS refund_amount
  FROM public.refunds r
  JOIN public.orders o
    ON o.id = r.order_id
  WHERE o.amount >= 100
  GROUP BY
    o.customer_id,
    DATE_TRUNC('month', o.created_at)
),
tickets_agg AS (
  SELECT
    customer_id,
    DATE_TRUNC('month', opened_at) AS month,
    COUNT(*) AS open_count
  FROM public.tickets
  WHERE status = 'open'
  GROUP BY
    customer_id,
    DATE_TRUNC('month', opened_at)
)
SELECT
  c.segment,
  o.month,
  SUM(o.revenue - COALESCE(r.refund_amount, 0)) AS net_revenue,
  SUM(o.revenue)                               AS revenue,
  SUM(r.refund_amount)                         AS refund_amount,
  SUM(COALESCE(t.open_count, 0))               AS open_tickets
FROM public.customers c
JOIN orders_agg o
  ON o.customer_id = c.id
LEFT JOIN refunds_agg r
  ON r.customer_id = c.id
 AND r.month = o.month
LEFT JOIN tickets_agg t
  ON t.customer_id = c.id
 AND t.month = o.month
WHERE c.is_test = false
GROUP BY
  c.segment,
  o.month
ORDER BY
  o.month,
  c.segment
LIMIT 1000;`,
    notes: [
      "Walks the reviewed join graph automatically",
      "Uses the canonical net_revenue formula",
      "Pre-aggregates each fact to avoid the chasm trap",
      "Keeps LEFT JOIN filters on the dimension source",
      "Transpiles DATE_TRUNC to the target dialect",
    ],
  },
  draggable: false,
  selectable: false,
};

const warehouse: WarehouseNode = {
  id: "warehouse",
  type: "warehouse",
  position: { x: WAREHOUSE_X, y: WAREHOUSE_Y },
  data: {
    variant: "warehouse",
    title: "Warehouse",
    drivers: ["PostgreSQL", "Snowflake", "BigQuery", "ClickHouse"],
  },
  draggable: false,
  selectable: false,
};

const nodes: FlowNode[] = [
  agent,
  manualSql,
  slQuery,
  engine,
  compiledSql,
  warehouse,
];

const arrowMarker = (color: string) => ({
  type: MarkerType.ArrowClosed,
  color,
  width: 16,
  height: 16,
});

const edges = [
  {
    id: "agent-manual",
    source: "agent",
    target: "manual-sql",
    type: "smoothstep" as const,
    label: "writes raw SQL",
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    labelStyle: {
      fontSize: 12,
      fontWeight: 500,
      fill: "var(--color-fd-muted-foreground)",
    },
    labelBgStyle: {
      fill: "var(--color-fd-background)",
      stroke: "var(--color-fd-border)",
      strokeWidth: 1,
    },
    style: {
      stroke: MANUAL_STROKE,
      strokeWidth: 1.5,
      strokeDasharray: "5 4",
    },
    markerEnd: arrowMarker(MANUAL_STROKE),
  },
  {
    id: "manual-warehouse",
    source: "manual-sql",
    target: "warehouse",
    type: "smoothstep" as const,
    style: {
      stroke: MANUAL_STROKE,
      strokeWidth: 1.5,
      strokeDasharray: "5 4",
    },
    markerEnd: arrowMarker(MANUAL_STROKE),
  },
  {
    id: "agent-slquery",
    source: "agent",
    target: "sl-query",
    type: "smoothstep" as const,
    label: "sends Semantic Query",
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    labelStyle: {
      fontSize: 12,
      fontWeight: 600,
      fill: KTX_STROKE,
    },
    labelBgStyle: {
      fill: "var(--color-fd-background)",
      stroke: "var(--color-fd-border)",
      strokeWidth: 1,
    },
    style: { stroke: KTX_STROKE, strokeWidth: 1.75 },
    markerEnd: arrowMarker(KTX_STROKE),
  },
  {
    id: "slquery-engine",
    source: "sl-query",
    target: "engine",
    type: "straight" as const,
    style: { stroke: KTX_STROKE, strokeWidth: 1.75 },
    markerEnd: arrowMarker(KTX_STROKE),
  },
  {
    id: "engine-compiled",
    source: "engine",
    target: "compiled-sql",
    type: "straight" as const,
    style: { stroke: KTX_STROKE, strokeWidth: 1.75 },
    markerEnd: arrowMarker(KTX_STROKE),
  },
  {
    id: "compiled-warehouse",
    source: "compiled-sql",
    target: "warehouse",
    type: "smoothstep" as const,
    style: { stroke: KTX_STROKE, strokeWidth: 1.75 },
    markerEnd: arrowMarker(KTX_STROKE),
  },
];

function AgentNodeView({ data }: NodeProps<AgentNode>) {
  return (
    <div
      style={{ width: AGENT_W, height: AGENT_H }}
      className="flex items-center gap-3 rounded-md border border-fd-border bg-fd-card px-4 py-3 shadow-sm"
    >
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-fd-primary/15 text-fd-primary">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="6" width="18" height="12" rx="3" />
          <circle cx="9" cy="12" r="1.25" fill="currentColor" stroke="none" />
          <circle cx="15" cy="12" r="1.25" fill="currentColor" stroke="none" />
          <path d="M12 3v3" />
        </svg>
      </div>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold leading-5 text-fd-foreground">
          {data.title}
        </p>
        <p className="mt-0.5 text-[12px] leading-4 text-fd-muted-foreground">
          {data.subtitle}
        </p>
      </div>
    </div>
  );
}

function LaneBadge({
  variant,
  children,
}: {
  variant: LaneVariant;
  children: React.ReactNode;
}) {
  const cls =
    variant === "manual"
      ? "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600/60 dark:bg-slate-700/40 dark:text-slate-200"
      : "border-cyan-300/70 bg-cyan-50 text-cyan-800 dark:border-cyan-400/40 dark:bg-cyan-400/15 dark:text-cyan-100";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] ${cls}`}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: variant === "manual" ? MANUAL_STROKE : KTX_STROKE,
        }}
      />
      {children}
    </span>
  );
}

function CodeBlock({
  language,
  code,
  tone,
}: {
  language: string;
  code: string;
  tone: "manual" | "slQuery" | "compiled";
}) {
  const toneClass =
    tone === "manual"
      ? "text-slate-600 dark:text-slate-300"
      : tone === "slQuery"
        ? "text-fd-primary"
        : "text-fd-primary/90";
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-fd-border bg-[#fbfaf6] dark:bg-[#0c1417]">
      <div className="flex flex-none items-center justify-between border-b border-fd-border bg-fd-muted/40 px-3 py-1.5">
        <span
          className={`font-mono font-medium tracking-wide ${toneClass}`}
          style={{ fontSize: "11px", lineHeight: "16px" }}
        >
          {language}
        </span>
        <span
          className="font-mono uppercase tracking-[0.08em] text-fd-muted-foreground"
          style={{ fontSize: "10.5px", lineHeight: "16px" }}
        >
          {tone === "compiled" ? "ktx-compiled" : "agent-authored"}
        </span>
      </div>
      <pre
        className="m-0 flex-1 overflow-auto px-3 py-2 font-mono text-fd-foreground"
        style={{ fontSize: "11.5px", lineHeight: "17.5px" }}
      >
        {code}
      </pre>
    </div>
  );
}

function ManualSqlNodeView({ data }: NodeProps<ManualSqlNode>) {
  return (
    <div
      style={{ width: LANE_W, height: MANUAL_SQL_H }}
      className="flex flex-col rounded-lg border border-fd-border bg-fd-card p-3.5 shadow-sm"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <LaneBadge variant="manual">{data.badge}</LaneBadge>
          <p className="mt-2 text-[15px] font-semibold leading-5 text-fd-foreground">
            {data.title}
          </p>
          <p className="mt-1 text-[12px] leading-5 text-fd-muted-foreground">
            {data.caption}
          </p>
        </div>
      </div>
      <div className="mt-3 min-h-0 flex-1">
        <CodeBlock language="sql" code={data.code} tone="manual" />
      </div>
      <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {data.notes.map((note) => (
          <li
            key={note}
            className="flex items-start gap-1.5 text-[11.5px] leading-4 text-fd-muted-foreground"
          >
            <span
              className="mt-1 h-1 w-1 flex-none rounded-full"
              style={{ background: MANUAL_STROKE }}
              aria-hidden="true"
            />
            <span>{note}</span>
          </li>
        ))}
      </ul>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function SlQueryNodeView({ data }: NodeProps<SlQueryNode>) {
  return (
    <div
      style={{ width: LANE_W, height: SL_QUERY_H }}
      className="flex flex-col rounded-lg border border-fd-primary/40 bg-fd-card p-3.5 shadow-sm"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <LaneBadge variant="ktx">{data.badge}</LaneBadge>
          <p className="mt-2 text-[15px] font-semibold leading-5 text-fd-foreground">
            {data.title}
          </p>
          <p className="mt-0.5 text-[12px] leading-4 text-fd-muted-foreground">
            {data.caption}
          </p>
        </div>
      </div>
      <div className="mt-2 min-h-0 flex-1 overflow-hidden">
        <CodeBlock language="json" code={data.code} tone="slQuery" />
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function EngineNodeView({ data }: NodeProps<EngineNode>) {
  return (
    <div
      style={{ width: LANE_W, height: ENGINE_H }}
      className="relative flex flex-col rounded-lg border border-cyan-200/30 bg-[#0f1f23] p-3.5 text-white shadow-sm dark:bg-[#0b181b]"
    >
      <span
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-lg"
        style={{ background: KTX_STROKE }}
        aria-hidden="true"
      />
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center justify-between">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-cyan-300">
          {data.badge}
        </p>
      </div>
      <p className="mt-1.5 text-[15px] font-semibold leading-5 text-white">
        {data.title}
      </p>
      <ol className="mt-3 flex flex-1 flex-col gap-1.5">
        {data.stages.map((stage) => (
          <li
            key={stage.index}
            className="flex items-start gap-3 rounded-md border border-cyan-100/15 bg-white/[0.04] px-3 py-2"
          >
            <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-cyan-300/95 font-mono text-[11px] font-semibold text-[#0b1c20]">
              {stage.index}
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold leading-[18px] text-white">
                {stage.title}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-[16px] text-cyan-50/80">
                {stage.detail}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function CompiledSqlNodeView({ data }: NodeProps<CompiledSqlNode>) {
  return (
    <div
      style={{ width: LANE_W, height: COMPILED_H }}
      className="flex flex-col rounded-lg border border-fd-primary/40 bg-fd-card p-3.5 shadow-sm"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <LaneBadge variant="ktx">{data.badge}</LaneBadge>
          <p className="mt-2 text-[15px] font-semibold leading-5 text-fd-foreground">
            {data.title}
          </p>
          <p className="mt-1 text-[12px] leading-5 text-fd-muted-foreground">
            {data.caption}
          </p>
        </div>
      </div>
      <div className="mt-3 min-h-0 flex-1">
        <CodeBlock language="sql" code={data.code} tone="compiled" />
      </div>
      <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {data.notes.map((note) => (
          <li
            key={note}
            className="flex items-start gap-1.5 text-[11.5px] leading-4 text-fd-muted-foreground"
          >
            <span
              className="mt-1 h-1 w-1 flex-none rounded-full"
              style={{ background: KTX_STROKE }}
              aria-hidden="true"
            />
            <span>{note}</span>
          </li>
        ))}
      </ul>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function WarehouseNodeView({ data }: NodeProps<WarehouseNode>) {
  return (
    <div
      style={{ width: WAREHOUSE_W, height: WAREHOUSE_H }}
      className="flex items-center gap-3 rounded-md border border-fd-border bg-fd-card px-4 py-3 shadow-sm"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex h-10 w-10 flex-none items-center justify-center rounded-md bg-fd-primary/12 text-fd-primary">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <ellipse cx="12" cy="5.5" rx="8" ry="2.6" />
          <path d="M4 5.5v6.2c0 1.43 3.58 2.6 8 2.6s8-1.17 8-2.6V5.5" />
          <path d="M4 11.7v6.2c0 1.43 3.58 2.6 8 2.6s8-1.17 8-2.6v-6.2" />
        </svg>
      </div>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold leading-5 text-fd-foreground">
          {data.title}
        </p>
        <p className="mt-0.5 text-[11.5px] leading-4 text-fd-muted-foreground">
          {data.drivers.join(" • ")}
        </p>
      </div>
    </div>
  );
}

const nodeTypes = {
  agent: AgentNodeView,
  manualSql: ManualSqlNodeView,
  slQuery: SlQueryNodeView,
  engine: EngineNodeView,
  compiledSql: CompiledSqlNodeView,
  warehouse: WarehouseNodeView,
};

export function SemanticLayerFlow() {
  return (
    <section
      className="not-prose my-10 w-full max-w-full min-w-0 space-y-4"
      aria-labelledby="sl-flow-title"
    >
      <article
        className="max-w-full min-w-0 overflow-hidden rounded-lg border border-fd-border bg-fd-card shadow-sm"
        aria-label="From Semantic Query to executed SQL: contrast between agent-authored SQL and KTX-compiled SQL"
      >
        <div className="border-b border-fd-border bg-fd-muted/35 px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fd-primary">
            Imperative vs declarative
          </p>
          <h3
            id="sl-flow-title"
            className="mt-1 text-base font-semibold tracking-normal text-fd-foreground sm:text-lg"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Same answer, two contracts
          </h3>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-fd-muted-foreground">
            On the left, the agent works imperatively: chooses tables, writes
            joins, picks the grain, and remembers each warehouse's dialect. On
            the right, the agent only declares what it wants. KTX handles
            every how.
          </p>
        </div>

        <div
          className="sl-flow-canvas bg-fd-background"
          style={{
            height: "min(2340px, 290vw)",
            minHeight: 1780,
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.05 }}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            panOnDrag={false}
            panOnScroll={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            minZoom={0.2}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1}
              color="var(--color-fd-border)"
            />
          </ReactFlow>
        </div>
      </article>
      <style>{`
        .sl-flow-canvas .react-flow__node {
          background: transparent;
          border: 0;
          box-shadow: none;
          padding: 0;
          border-radius: 0;
          width: auto;
          text-align: left;
          user-select: text;
          -webkit-user-select: text;
          cursor: auto;
          pointer-events: all !important;
        }
        .sl-flow-canvas .react-flow__node > * {
          pointer-events: auto;
          user-select: text;
          -webkit-user-select: text;
        }
        .sl-flow-canvas .react-flow__node.selected,
        .sl-flow-canvas .react-flow__node:focus,
        .sl-flow-canvas .react-flow__node:focus-visible {
          outline: none;
          box-shadow: none;
        }
        .sl-flow-canvas .react-flow__pane {
          cursor: default;
        }
        .sl-flow-canvas .react-flow__handle {
          width: 1px;
          height: 1px;
          min-width: 0;
          min-height: 0;
          background: transparent;
          border: 0;
          pointer-events: none;
        }
        .sl-flow-canvas pre {
          font-size: 11.5px !important;
          line-height: 17.5px !important;
          background: transparent !important;
          padding: 8px 12px !important;
          border: 0 !important;
          margin: 0 !important;
          box-shadow: none !important;
        }
        .sl-flow-canvas .react-flow__node pre code,
        .sl-flow-canvas .react-flow__node pre span {
          font-size: inherit !important;
          line-height: inherit !important;
        }
      `}</style>
    </section>
  );
}
