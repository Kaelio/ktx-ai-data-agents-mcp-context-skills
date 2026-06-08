import { type Edge, MarkerType, type Node } from "@xyflow/react";

import { C } from "./nodes";

const EDGE_COLOR = "#b3bcc4";
const MARKER_COLOR = "#9aa6ad";

const labelStyle = {
  fontFamily: "var(--font-inter), system-ui, sans-serif",
  fontSize: 15,
  fontWeight: 600,
  fill: C.inkMuted,
};
const labelBgStyle = { fill: "#ffffff", stroke: C.chipBorder, strokeWidth: 1 };
const labelBg = {
  labelBgPadding: [8, 4] as [number, number],
  labelBgBorderRadius: 6,
  labelStyle,
  labelBgStyle,
};

const marker = { type: MarkerType.ArrowClosed, color: MARKER_COLOR, width: 16, height: 16 };
const edgeStyle = { stroke: EDGE_COLOR, strokeWidth: 2 };

/* ============================== INGESTION =============================== */

const SRC_W = 300;
const SRC_H = 138;
const SRC_GAP = 24;
const srcY = (i: number) => i * (SRC_H + SRC_GAP);

export const ingestionNodes: Node[] = [
  {
    id: "title",
    type: "title",
    position: { x: 0, y: -96 },
    data: {
      width: 560,
      eyebrow: "1 · Ingestion",
      title: "ktx builds your context layer",
    },
  },
  {
    id: "db",
    type: "card",
    position: { x: 0, y: srcY(0) },
    data: {
      width: SRC_W,
      height: SRC_H,
      accent: C.teal,
      rows: [
        { kind: "title", text: "Databases" },
        { kind: "desc", text: "Schemas, keys, query history" },
        { kind: "muted", text: "Postgres · Snowflake · BigQuery · …" },
      ],
      handles: [{ side: "right", type: "source", id: "out" }],
    },
  },
  {
    id: "bi",
    type: "card",
    position: { x: 0, y: srcY(1) },
    data: {
      width: SRC_W,
      height: SRC_H,
      accent: C.orange,
      rows: [
        { kind: "title", text: "BI tools" },
        { kind: "desc", text: "Dashboards, explores, usage" },
        { kind: "muted", text: "Metabase · Looker · …" },
      ],
      handles: [{ side: "right", type: "source", id: "out" }],
    },
  },
  {
    id: "model",
    type: "card",
    position: { x: 0, y: srcY(2) },
    data: {
      width: SRC_W,
      height: SRC_H,
      accent: C.amber,
      rows: [
        { kind: "title", text: "Modeling code" },
        { kind: "desc", text: "Metrics, models, joins, entities" },
        { kind: "muted", text: "dbt · LookML · MetricFlow · …" },
      ],
      handles: [{ side: "right", type: "source", id: "out" }],
    },
  },
  {
    id: "docs",
    type: "card",
    position: { x: 0, y: srcY(3) },
    data: {
      width: SRC_W,
      height: SRC_H,
      accent: C.emerald,
      rows: [
        { kind: "title", text: "Docs & notes" },
        { kind: "desc", text: "Policies, definitions, notes" },
        { kind: "muted", text: "Notion · any text · …" },
      ],
      handles: [{ side: "right", type: "source", id: "out" }],
    },
  },
  {
    id: "engine",
    type: "engine",
    position: { x: 420, y: 52 },
    data: {
      width: 380,
      height: 520,
      steps: [
        { n: 1, title: "Source connectors", desc: "Read each source in its shape" },
        { n: 2, title: "Context builder", desc: "Evidence into proposed updates" },
        { n: 3, title: "Reconciliation", desc: "Merge with existing context" },
        { n: 4, title: "Validation", desc: "Check references & semantics" },
      ],
      handles: [
        { side: "left", type: "target", id: "in" },
        { side: "right", type: "source", id: "out" },
      ],
    },
  },
  {
    id: "wiki",
    type: "card",
    position: { x: 900, y: 66 },
    data: {
      width: 320,
      height: 220,
      accent: C.emerald,
      rows: [
        { kind: "mono", text: "wiki/*.md", color: C.emerald },
        { kind: "title", text: "Wiki" },
        { kind: "chips", items: ["free-form", "auto-maintained"] },
        { kind: "desc", text: "Definitions, caveats, policies," },
        { kind: "desc", text: "and notes agents can search." },
      ],
      handles: [{ side: "left", type: "target", id: "in" }],
    },
  },
  {
    id: "sl",
    type: "card",
    position: { x: 900, y: 338 },
    data: {
      width: 320,
      height: 220,
      accent: C.teal,
      rows: [
        { kind: "mono", text: "semantic-layer/*.yaml", color: C.teal },
        { kind: "title", text: "Semantic layer" },
        { kind: "chips", items: ["executable", "auto-maintained"] },
        { kind: "desc", text: "Metrics, joins, dimensions, and" },
        { kind: "desc", text: "filters ktx compiles into SQL." },
      ],
      handles: [{ side: "left", type: "target", id: "in" }],
    },
  },
];

const ingestEdge = (source: string, target: string): Edge => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle: "out",
  targetHandle: "in",
  type: "default",
  style: edgeStyle,
  markerEnd: marker,
});

export const ingestionEdges: Edge[] = [
  ingestEdge("db", "engine"),
  ingestEdge("bi", "engine"),
  ingestEdge("model", "engine"),
  ingestEdge("docs", "engine"),
  ingestEdge("engine", "wiki"),
  ingestEdge("engine", "sl"),
];

/* =============================== RUNTIME ================================ */

export const runtimeNodes: Node[] = [
  {
    id: "title",
    type: "title",
    position: { x: 0, y: -84 },
    data: {
      width: 560,
      eyebrow: "2 · Serving",
      title: "agents query it through MCP",
    },
  },
  {
    id: "agent",
    type: "card",
    position: { x: 0, y: 115 },
    data: {
      width: 280,
      height: 190,
      accent: C.neutral,
      align: "center",
      rows: [
        { kind: "title", text: "Your agent" },
        { kind: "muted", text: "Claude Code · Cursor" },
        { kind: "muted", text: "Codex · OpenCode" },
      ],
      handles: [
        { side: "right", type: "source", id: "ask", top: "42%" },
        { side: "right", type: "target", id: "answer", top: "62%" },
      ],
    },
  },
  {
    id: "hub",
    type: "hub",
    position: { x: 420, y: 85 },
    data: {
      width: 360,
      height: 250,
      rows: [
        "Search wiki + semantic layer",
        "Return approved metrics",
        "Compile metrics → SQL",
      ],
      handles: [
        { side: "left", type: "target", id: "ask", top: "42%" },
        { side: "left", type: "source", id: "answer", top: "62%" },
        { side: "right", type: "source", id: "to-context", top: "30%" },
        { side: "right", type: "source", id: "to-warehouse", top: "72%" },
      ],
    },
  },
  {
    id: "context",
    type: "card",
    position: { x: 920, y: 15 },
    data: {
      width: 300,
      height: 150,
      accent: C.teal,
      rows: [
        { kind: "title", text: "Context layer" },
        { kind: "mono", text: "wiki/*.md", color: C.emerald },
        { kind: "mono", text: "semantic-layer/*.yaml", color: C.teal },
      ],
      handles: [{ side: "left", type: "target", id: "in" }],
    },
  },
  {
    id: "warehouse",
    type: "card",
    position: { x: 920, y: 255 },
    data: {
      width: 300,
      height: 150,
      accent: C.slate,
      rows: [
        { kind: "title", text: "Warehouse" },
        {
          kind: "badge",
          text: "read-only",
          bg: "#ecf6f8",
          border: "#bfe3ea",
          color: C.teal,
        },
        { kind: "desc", text: "Runs the compiled SQL" },
      ],
      handles: [{ side: "left", type: "target", id: "in" }],
    },
  },
];

export const runtimeEdges: Edge[] = [
  {
    id: "ask",
    source: "agent",
    sourceHandle: "ask",
    target: "hub",
    targetHandle: "ask",
    type: "default",
    label: "ask",
    ...labelBg,
    style: edgeStyle,
    markerEnd: marker,
  },
  {
    id: "answer",
    source: "hub",
    sourceHandle: "answer",
    target: "agent",
    targetHandle: "answer",
    type: "default",
    label: "answer",
    ...labelBg,
    style: edgeStyle,
    markerEnd: marker,
  },
  {
    id: "search",
    source: "hub",
    sourceHandle: "to-context",
    target: "context",
    targetHandle: "in",
    type: "smoothstep",
    label: "search + read",
    ...labelBg,
    style: edgeStyle,
    markerStart: marker,
    markerEnd: marker,
  },
  {
    id: "readonly",
    source: "hub",
    sourceHandle: "to-warehouse",
    target: "warehouse",
    targetHandle: "in",
    type: "smoothstep",
    label: "read-only",
    ...labelBg,
    style: edgeStyle,
    markerStart: marker,
    markerEnd: marker,
  },
];
