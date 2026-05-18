"use client";

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type SourceNodeData = {
  accent: string;
  body: string;
  items: string[];
  title: string;
};

type StageNodeData = {
  body: string;
  index: number;
  title: string;
};

type OutputNodeData = {
  accent: string;
  body: string;
  path: string;
  tags: string[];
  title: string;
};

type SourceNode = Node<SourceNodeData, "source">;
type StageNode = Node<StageNodeData, "stage">;
type OutputNode = Node<OutputNodeData, "output">;
type FlowNode = SourceNode | StageNode | OutputNode;

const SOURCE_W = 210;
const SOURCE_H = 200;
const STAGE_W = 280;
const STAGE_H = 120;
const OUTPUT_W = 340;
const OUTPUT_H = 232;

const ROW_SOURCES_Y = 80;
const ROW_STAGE_START_Y = 360;
const STAGE_GAP = 30;
const ROW_OUTPUTS_Y = 1000;

const STAGE_CENTER_X = 460;
const STAGE_X = STAGE_CENTER_X - STAGE_W / 2;

const SOURCE_GAP_X = 24;
const SOURCES_TOTAL = SOURCE_W * 4 + SOURCE_GAP_X * 3;
const SOURCES_START_X = STAGE_CENTER_X - SOURCES_TOTAL / 2;

const OUTPUT_GAP_X = 180;
const OUTPUTS_TOTAL = OUTPUT_W * 2 + OUTPUT_GAP_X;
const OUTPUTS_START_X = STAGE_CENTER_X - OUTPUTS_TOTAL / 2;

const EDGE_STROKE = "#94a3b8";

const sourceData: SourceNodeData[] = [
  {
    title: "Databases",
    body: "Schemas, columns, keys, row counts, and query history.",
    items: ["PostgreSQL", "Snowflake", "BigQuery", "SQLite"],
    accent: "#3b82f6",
  },
  {
    title: "BI tools",
    body: "Dashboards, questions, explores, usage, and trusted examples.",
    items: ["Metabase", "Looker"],
    accent: "#f97316",
  },
  {
    title: "Modeling code",
    body: "Existing metrics, dimensions, models, joins, and entities.",
    items: ["dbt", "LookML", "MetricFlow"],
    accent: "#f59e0b",
  },
  {
    title: "Docs and notes",
    body: "Policies, caveats, team definitions, and analyst context.",
    items: ["Notion", "Any text"],
    accent: "#10b981",
  },
];

const stageData: Omit<StageNodeData, "index">[] = [
  {
    title: "Source adapters",
    body: "Read each configured system in its native shape.",
  },
  {
    title: "Context builder",
    body: "Turn source evidence into proposed context updates.",
  },
  {
    title: "Reconciliation",
    body: "Merge new evidence with the context that already exists.",
  },
  {
    title: "Validation",
    body: "Check references and semantics before agents rely on them.",
  },
];

const outputData: OutputNodeData[] = [
  {
    title: "Wiki",
    path: "wiki/*.md",
    tags: ["free-form", "auto-maintained"],
    body: "Definitions, caveats, policies, analyst notes, and business language that agents can search.",
    accent: "#10b981",
  },
  {
    title: "Semantic layer",
    path: "semantic-layer/*.yaml",
    tags: ["structured", "executable", "auto-maintained"],
    body: "Metrics, joins, tables, dimensions, filters, and segments that KTX can validate and compile into SQL.",
    accent: "#3b82f6",
  },
];

const nodes: FlowNode[] = [
  ...sourceData.map<SourceNode>((source, index) => ({
    id: `source-${index}`,
    type: "source",
    position: {
      x: SOURCES_START_X + index * (SOURCE_W + SOURCE_GAP_X),
      y: ROW_SOURCES_Y,
    },
    data: source,
    draggable: false,
    selectable: false,
  })),
  ...stageData.map<StageNode>((stage, index) => ({
    id: `stage-${index}`,
    type: "stage",
    position: {
      x: STAGE_X,
      y: ROW_STAGE_START_Y + index * (STAGE_H + STAGE_GAP),
    },
    data: { ...stage, index: index + 1 },
    draggable: false,
    selectable: false,
  })),
  ...outputData.map<OutputNode>((output, index) => ({
    id: `output-${index}`,
    type: "output",
    position: {
      x: OUTPUTS_START_X + index * (OUTPUT_W + OUTPUT_GAP_X),
      y: ROW_OUTPUTS_Y,
    },
    data: output,
    draggable: false,
    selectable: false,
  })),
];

const REF_EDGE_STROKE = "#64748b";

const flowEdges = [
  ...sourceData.map((_, index) => ({
    id: `e-source-${index}-stage-0`,
    source: `source-${index}`,
    target: "stage-0",
  })),
  ...stageData.slice(0, -1).map((_, index) => ({
    id: `e-stage-${index}-stage-${index + 1}`,
    source: `stage-${index}`,
    target: `stage-${index + 1}`,
  })),
  ...outputData.map((_, index) => ({
    id: `e-stage-3-output-${index}`,
    source: "stage-3",
    target: `output-${index}`,
  })),
].map((edge) => ({
  ...edge,
  type: "animated" as const,
  style: { stroke: EDGE_STROKE, strokeWidth: 1.5 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: EDGE_STROKE,
    width: 16,
    height: 16,
  },
}));

const refsEdge = {
  id: "e-output-refs",
  source: "output-0",
  sourceHandle: "right",
  target: "output-1",
  targetHandle: "left",
  type: "straight" as const,
  label: "references",
  labelBgPadding: [6, 3] as [number, number],
  labelBgBorderRadius: 4,
  labelStyle: {
    fontSize: 13,
    fontWeight: 500,
    fill: "var(--color-fd-muted-foreground)",
  },
  labelBgStyle: {
    fill: "var(--color-fd-background)",
    stroke: "var(--color-fd-border)",
    strokeWidth: 1,
  },
  style: {
    stroke: REF_EDGE_STROKE,
    strokeWidth: 1.25,
    strokeDasharray: "4 4",
  },
  markerStart: {
    type: MarkerType.ArrowClosed,
    color: REF_EDGE_STROKE,
    width: 14,
    height: 14,
  },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: REF_EDGE_STROKE,
    width: 14,
    height: 14,
  },
};

const edges = [...flowEdges, refsEdge];

function SourceNodeView({ data }: NodeProps<SourceNode>) {
  return (
    <div
      style={{
        width: SOURCE_W,
        height: SOURCE_H,
        borderTop: `3px solid ${data.accent}`,
      }}
      className="overflow-hidden rounded-md border border-fd-border bg-fd-card px-3.5 py-3 shadow-sm"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <p className="text-[16px] font-semibold leading-6 text-fd-foreground">
        {data.title}
      </p>
      <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-fd-muted-foreground">
        {data.body}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {data.items.map((item) => (
          <span
            key={item}
            className="rounded border border-fd-border bg-fd-background px-1.5 py-0.5 text-[12px] leading-5 text-fd-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function StageNodeView({ data }: NodeProps<StageNode>) {
  return (
    <div
      style={{ width: STAGE_W, height: STAGE_H }}
      className="flex items-center gap-3.5 rounded-md border border-cyan-200/20 bg-[#0f1f23] px-4 py-3.5 text-white shadow-sm dark:bg-[#0b181b]"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-cyan-300/95 font-mono text-sm font-semibold text-[#0b1c20]">
        {data.index}
      </span>
      <div className="min-w-0">
        <p className="text-[16px] font-semibold leading-6 text-white">
          {data.title}
        </p>
        <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-cyan-50/75">
          {data.body}
        </p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function OutputNodeView({ data }: NodeProps<OutputNode>) {
  return (
    <div
      style={{
        width: OUTPUT_W,
        height: OUTPUT_H,
        borderTop: `3px solid ${data.accent}`,
      }}
      className="overflow-hidden rounded-md border border-fd-border bg-fd-card px-4 py-3.5 shadow-sm"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle
        id="left"
        type="target"
        position={Position.Left}
        className="!opacity-0"
      />
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        className="!opacity-0"
      />
      <p
        className="font-mono text-[13px] font-semibold tracking-tight"
        style={{ color: data.accent }}
      >
        {data.path}
      </p>
      <p className="mt-1.5 text-[16px] font-semibold leading-6 text-fd-foreground">
        {data.title}
      </p>
      <div className="mt-1.5 flex flex-nowrap gap-1">
        {data.tags.map((tag) => (
          <span
            key={tag}
            className="whitespace-nowrap rounded border border-fd-border bg-fd-background px-1.5 py-0.5 text-[12px] leading-5 text-fd-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </div>
      <p className="mt-2 line-clamp-3 text-[13px] leading-5 text-fd-muted-foreground">
        {data.body}
      </p>
    </div>
  );
}

const DOT_CORE_COLOR = "#67e8f9";
const DOT_GLOW_COLOR = "#22d3ee";
const DOT_SPEED_PX_PER_SEC = 110;
const DOT_MIN_DURATION_SEC = 0.7;

function AnimatedSmoothStepEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const pathId = `mechanics-flow-${id}`;
  const approxLength =
    Math.abs(targetX - sourceX) + Math.abs(targetY - sourceY);
  const duration = Math.max(
    DOT_MIN_DURATION_SEC,
    approxLength / DOT_SPEED_PX_PER_SEC,
  );
  const durAttr = `${duration.toFixed(2)}s`;
  const beginAttr = `-${(duration / 2).toFixed(2)}s`;

  return (
    <>
      <BaseEdge id={pathId} path={path} style={style} markerEnd={markerEnd} />
      <g className="mechanics-flow-dot">
        <circle r={6.5} fill={DOT_GLOW_COLOR} opacity={0.22} />
        <circle r={2.6} fill={DOT_CORE_COLOR} />
        <animateMotion dur={durAttr} repeatCount="indefinite">
          <mpath href={`#${pathId}`} />
        </animateMotion>
      </g>
      <g className="mechanics-flow-dot">
        <circle r={5} fill={DOT_GLOW_COLOR} opacity={0.14} />
        <circle r={2} fill={DOT_CORE_COLOR} opacity={0.7} />
        <animateMotion
          dur={durAttr}
          begin={beginAttr}
          repeatCount="indefinite"
        >
          <mpath href={`#${pathId}`} />
        </animateMotion>
      </g>
    </>
  );
}

const nodeTypes = {
  source: SourceNodeView,
  stage: StageNodeView,
  output: OutputNodeView,
};

const edgeTypes = {
  animated: AnimatedSmoothStepEdge,
};

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
          How ingestion works
        </h2>
        <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
          KTX ingests source evidence, reconciles it with your existing project,
          and produces durable context that agents can search, review, and
          execute.
        </p>
      </div>

      <article
        className="max-w-full min-w-0 overflow-hidden rounded-lg border border-fd-border bg-fd-card shadow-sm"
        aria-label="KTX ingestion flow from source systems to durable context outputs"
      >
        <div className="border-b border-fd-border bg-fd-muted/35 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-fd-primary">
            Ingestion flow
          </p>
          <h3
            className="mt-1 text-base font-semibold tracking-normal text-fd-foreground sm:text-lg"
            style={{ fontFamily: "var(--font-display)" }}
          >
            From scattered source systems to agent-ready context
          </h3>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-fd-muted-foreground">
            The inputs can be structured systems or loose team knowledge. The
            outputs are the two files agents need: a readable wiki and an
            executable semantic layer.
          </p>
        </div>

        <div
          className="mechanics-canvas bg-fd-background"
          style={{
            height: "min(1180px, 165vw)",
            minHeight: 680,
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.04 }}
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
        .mechanics-canvas .react-flow__node {
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
        .mechanics-canvas .react-flow__node > * {
          pointer-events: auto;
          user-select: text;
          -webkit-user-select: text;
        }
        .mechanics-canvas .react-flow__node.selected,
        .mechanics-canvas .react-flow__node:focus,
        .mechanics-canvas .react-flow__node:focus-visible {
          outline: none;
          box-shadow: none;
        }
        .mechanics-canvas .react-flow__pane {
          cursor: default;
        }
        .mechanics-canvas .react-flow__handle {
          width: 1px;
          height: 1px;
          min-width: 0;
          min-height: 0;
          background: transparent;
          border: 0;
          pointer-events: none;
        }
        .mechanics-canvas .mechanics-flow-dot {
          pointer-events: none;
          filter: drop-shadow(0 0 6px rgba(34, 211, 238, 0.45));
        }
        @media (prefers-reduced-motion: reduce) {
          .mechanics-canvas .mechanics-flow-dot {
            display: none;
          }
        }
      `}</style>
    </section>
  );
}
