"use client";

import {
  type Edge,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
} from "@xyflow/react";

import { FlowCanvas } from "./flow-canvas";

type AgentNodeData = {
  title: string;
  items: string[];
};

type HubNodeData = {
  title: string;
  badge: string;
  rows: string[];
};

type TargetNodeData = {
  accent: string;
  title: string;
  body: string;
  rows: { text: string; color?: string; mono?: boolean }[];
  badge?: string;
};

type AgentNode = Node<AgentNodeData, "agent">;
type HubNode = Node<HubNodeData, "hub">;
type TargetNode = Node<TargetNodeData, "target">;
type FlowNode = AgentNode | HubNode | TargetNode;

const AGENT_W = 252;
const AGENT_H = 96;
const HUB_W = 306;
const HUB_H = 190;
const TARGET_W = 268;
const TARGET_H = 148;

const CENTER_X = 470;
const ROW_AGENT_Y = 0;
const ROW_HUB_Y = 196;
const ROW_TARGET_Y = 488;

const AGENT_X = CENTER_X - AGENT_W / 2;
const HUB_X = CENTER_X - HUB_W / 2;

const TARGET_GAP_X = 38;
const TARGETS_TOTAL = TARGET_W * 2 + TARGET_GAP_X;
const TARGETS_START_X = CENTER_X - TARGETS_TOTAL / 2;
const CONTEXT_X = TARGETS_START_X;
const WAREHOUSE_X = TARGETS_START_X + TARGET_W + TARGET_GAP_X;

const EDGE_STROKE = "#94a3b8";
const CYCLE_STROKE = "#0e7490";
const EMERALD = "#059669";
const TEAL = "#0e7490";

const nodes: FlowNode[] = [
  {
    id: "agent",
    type: "agent",
    position: { x: AGENT_X, y: ROW_AGENT_Y },
    data: {
      title: "Your agent",
      items: ["Claude Code", "Cursor", "Codex"],
    },
    draggable: false,
    selectable: false,
  },
  {
    id: "hub",
    type: "hub",
    position: { x: HUB_X, y: ROW_HUB_Y },
    data: {
      title: "ktx",
      badge: "MCP + CLI",
      rows: [
        "Search wiki + semantic layer",
        "Return approved metrics",
        "Compile metrics → SQL",
      ],
    },
    draggable: false,
    selectable: false,
  },
  {
    id: "context",
    type: "target",
    position: { x: CONTEXT_X, y: ROW_TARGET_Y },
    data: {
      accent: TEAL,
      title: "Context layer",
      body: "Approved definitions agents search before they answer.",
      rows: [
        { text: "wiki/*.md", color: EMERALD, mono: true },
        { text: "semantic-layer/*.yaml", color: TEAL, mono: true },
      ],
    },
    draggable: false,
    selectable: false,
  },
  {
    id: "warehouse",
    type: "target",
    position: { x: WAREHOUSE_X, y: ROW_TARGET_Y },
    data: {
      accent: "#334155",
      title: "Database",
      badge: "read-only",
      body: "Runs the compiled SQL. ktx never writes to it.",
      rows: [],
    },
    draggable: false,
    selectable: false,
  },
];

const labelBg = {
  labelBgPadding: [6, 3] as [number, number],
  labelBgBorderRadius: 4,
  labelStyle: {
    fontSize: 13,
    fontWeight: 600,
    fill: "var(--color-fd-muted-foreground)",
  },
  labelBgStyle: {
    fill: "var(--color-fd-background)",
    stroke: "var(--color-fd-border)",
    strokeWidth: 1,
  },
};

const requestMarker = {
  type: MarkerType.ArrowClosed,
  color: EDGE_STROKE,
  width: 16,
  height: 16,
};

const flowEdges: Edge[] = [
  {
    id: "e-ask",
    source: "agent",
    sourceHandle: "ask",
    target: "hub",
    targetHandle: "ask",
    type: "straight",
    label: "ask",
    ...labelBg,
    style: { stroke: EDGE_STROKE, strokeWidth: 1.5 },
    markerEnd: requestMarker,
  },
  {
    id: "e-answer",
    source: "hub",
    sourceHandle: "answer",
    target: "agent",
    targetHandle: "answer",
    type: "straight",
    label: "answer",
    ...labelBg,
    style: { stroke: EDGE_STROKE, strokeWidth: 1.5 },
    markerEnd: requestMarker,
  },
  {
    id: "e-search",
    source: "hub",
    sourceHandle: "to-context",
    target: "context",
    targetHandle: "in",
    type: "smoothstep",
    label: "search + read",
    ...labelBg,
    style: { stroke: CYCLE_STROKE, strokeWidth: 1.5 },
    markerStart: { type: MarkerType.ArrowClosed, color: CYCLE_STROKE, width: 14, height: 14 },
    markerEnd: { type: MarkerType.ArrowClosed, color: CYCLE_STROKE, width: 14, height: 14 },
  },
  {
    id: "e-readonly",
    source: "hub",
    sourceHandle: "to-warehouse",
    target: "warehouse",
    targetHandle: "in",
    type: "smoothstep",
    label: "read-only",
    ...labelBg,
    style: { stroke: CYCLE_STROKE, strokeWidth: 1.5 },
    markerStart: { type: MarkerType.ArrowClosed, color: CYCLE_STROKE, width: 14, height: 14 },
    markerEnd: { type: MarkerType.ArrowClosed, color: CYCLE_STROKE, width: 14, height: 14 },
  },
];

function AgentNodeView({ data }: NodeProps<AgentNode>) {
  return (
    <div
      style={{ width: AGENT_W, height: AGENT_H }}
      className="flex flex-col justify-center rounded-md border border-fd-border bg-fd-card px-3.5 py-2.5 shadow-sm"
    >
      <Handle
        id="ask"
        type="source"
        position={Position.Bottom}
        className="!opacity-0"
        style={{ left: "35%" }}
      />
      <Handle
        id="answer"
        type="target"
        position={Position.Bottom}
        className="!opacity-0"
        style={{ left: "65%" }}
      />
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-fd-primary/15 text-fd-primary">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
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
        </span>
        <p className="text-[17px] font-semibold leading-6 text-fd-foreground">
          {data.title}
        </p>
      </div>
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
    </div>
  );
}

function HubNodeView({ data }: NodeProps<HubNode>) {
  return (
    <div
      style={{ width: HUB_W, height: HUB_H }}
      className="relative flex flex-col rounded-md border border-cyan-200/20 bg-[#0f1f23] px-4 py-3.5 text-white shadow-sm dark:bg-[#0b181b]"
    >
      <Handle
        id="ask"
        type="target"
        position={Position.Top}
        className="!opacity-0"
        style={{ left: "37.5%" }}
      />
      <Handle
        id="answer"
        type="source"
        position={Position.Top}
        className="!opacity-0"
        style={{ left: "62.5%" }}
      />
      <Handle
        id="to-context"
        type="source"
        position={Position.Bottom}
        className="!opacity-0"
        style={{ left: "44%" }}
      />
      <Handle
        id="to-warehouse"
        type="source"
        position={Position.Bottom}
        className="!opacity-0"
        style={{ left: "56%" }}
      />
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-cyan-300/95 font-mono text-sm font-bold text-[#0b1c20]">
          k
        </span>
        <span className="text-[19px] font-bold leading-6 text-white">
          {data.title}
        </span>
        <span className="ml-1 rounded border border-cyan-200/30 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] leading-5 text-cyan-100/85">
          {data.badge}
        </span>
      </div>
      <div className="mt-3 flex flex-1 flex-col justify-center gap-2">
        {data.rows.map((row) => (
          <div key={row} className="flex items-center gap-2.5">
            <span className="h-1.5 w-1.5 flex-none rounded-full bg-cyan-300/95" />
            <span className="text-[14px] font-medium leading-5 text-cyan-50/90">
              {row}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TargetNodeView({ data }: NodeProps<TargetNode>) {
  return (
    <div
      style={{
        width: TARGET_W,
        height: TARGET_H,
        borderTop: `3px solid ${data.accent}`,
      }}
      className="overflow-hidden rounded-md border border-fd-border bg-fd-card px-3.5 py-3 shadow-sm"
    >
      <Handle id="in" type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <p className="text-[17px] font-semibold leading-6 text-fd-foreground">
          {data.title}
        </p>
        {data.badge ? (
          <span
            className="rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-5"
            style={{
              color: data.accent,
              background: "color-mix(in oklch, var(--color-fd-card) 86%, #64748b)",
            }}
          >
            {data.badge}
          </span>
        ) : null}
      </div>
      {data.rows.length > 0 ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {data.rows.map((row) => (
            <span
              key={row.text}
              className={
                row.mono
                  ? "font-mono text-[13px] font-semibold tracking-tight"
                  : "text-[12px] leading-4 text-fd-muted-foreground"
              }
              style={row.color ? { color: row.color } : undefined}
            >
              {row.text}
            </span>
          ))}
        </div>
      ) : null}
      <p className="mt-1.5 line-clamp-2 text-[13px] leading-[18px] text-fd-muted-foreground">
        {data.body}
      </p>
    </div>
  );
}

/* ------------------------------- Particles ------------------------------- */

const PARTICLE_SPEED_PX_PER_SEC = 150;
const PARTICLE_MIN_DURATION_SEC = 5;

type Leg = {
  sx: number;
  sy: number;
  sPos: Position;
  tx: number;
  ty: number;
  tPos: Position;
};

const AGENT_ASK_X = AGENT_X + AGENT_W * 0.35;
const AGENT_ANSWER_X = AGENT_X + AGENT_W * 0.65;
const AGENT_BOTTOM_Y = ROW_AGENT_Y + AGENT_H;
const HUB_ASK_X = HUB_X + HUB_W * 0.375;
const HUB_ANSWER_X = HUB_X + HUB_W * 0.625;
const HUB_TO_CONTEXT_X = HUB_X + HUB_W * 0.44;
const HUB_TO_WAREHOUSE_X = HUB_X + HUB_W * 0.56;
const HUB_BOTTOM_Y = ROW_HUB_Y + HUB_H;
const CONTEXT_TOP_X = CONTEXT_X + TARGET_W / 2;
const WAREHOUSE_TOP_X = WAREHOUSE_X + TARGET_W / 2;

function buildCyclePath(spokeX: number, targetX: number): {
  d: string;
  length: number;
} {
  const legs: Leg[] = [
    // agent → hub (ask, down)
    { sx: AGENT_ASK_X, sy: AGENT_BOTTOM_Y, sPos: Position.Bottom, tx: HUB_ASK_X, ty: ROW_HUB_Y, tPos: Position.Top },
    // through the hub to its spoke handle (down, drawn behind the hub)
    { sx: HUB_ASK_X, sy: ROW_HUB_Y, sPos: Position.Bottom, tx: spokeX, ty: HUB_BOTTOM_Y, tPos: Position.Top },
    // hub → target (down)
    { sx: spokeX, sy: HUB_BOTTOM_Y, sPos: Position.Bottom, tx: targetX, ty: ROW_TARGET_Y, tPos: Position.Top },
    // target → hub (up)
    { sx: targetX, sy: ROW_TARGET_Y, sPos: Position.Top, tx: spokeX, ty: HUB_BOTTOM_Y, tPos: Position.Bottom },
    // through the hub to its answer handle (up, drawn behind the hub)
    { sx: spokeX, sy: HUB_BOTTOM_Y, sPos: Position.Top, tx: HUB_ANSWER_X, ty: ROW_HUB_Y, tPos: Position.Bottom },
    // hub → agent (answer, up)
    { sx: HUB_ANSWER_X, sy: ROW_HUB_Y, sPos: Position.Top, tx: AGENT_ANSWER_X, ty: AGENT_BOTTOM_Y, tPos: Position.Bottom },
  ];

  const segments = legs.map((leg) => {
    const [segment] = getSmoothStepPath({
      sourceX: leg.sx,
      sourceY: leg.sy,
      sourcePosition: leg.sPos,
      targetX: leg.tx,
      targetY: leg.ty,
      targetPosition: leg.tPos,
    });
    return segment;
  });

  let d = segments[0];
  for (let i = 1; i < segments.length; i += 1) {
    d += ` ${segments[i].replace(/^M/, "L")}`;
  }

  const length = legs.reduce(
    (sum, leg) => sum + Math.abs(leg.tx - leg.sx) + Math.abs(leg.ty - leg.sy),
    0,
  );

  return { d, length };
}

type ParticleEdgeData = {
  d: string;
  duration: number;
  beginOffset: number;
  color: string;
};

type ParticleEdge = Edge<ParticleEdgeData, "particle">;

function ParticleEdgeView({ id, data }: EdgeProps<ParticleEdge>) {
  if (!data) return null;
  const pathId = `runtime-particle-path-${id}`;
  return (
    <>
      <path id={pathId} d={data.d} fill="none" stroke="none" pointerEvents="none" />
      <g className="runtime-particle" style={{ color: data.color }}>
        <circle r={7.5} fill="currentColor" opacity={0.16} />
        <circle r={3.75} fill="currentColor" opacity={0.32} />
        <circle r={2.1} fill="currentColor" />
        <animateMotion
          dur={`${data.duration.toFixed(2)}s`}
          begin={`-${data.beginOffset.toFixed(2)}s`}
          repeatCount="indefinite"
        >
          <mpath href={`#${pathId}`} />
        </animateMotion>
      </g>
    </>
  );
}

function makeCycleEdge(
  id: string,
  source: string,
  spokeX: number,
  targetX: number,
  beginFraction: number,
): ParticleEdge {
  const { d, length } = buildCyclePath(spokeX, targetX);
  const duration = Math.max(
    PARTICLE_MIN_DURATION_SEC,
    length / PARTICLE_SPEED_PX_PER_SEC,
  );
  return {
    id,
    source,
    target: source,
    type: "particle",
    data: { d, duration, beginOffset: duration * beginFraction, color: CYCLE_STROKE },
  };
}

const particleEdges: ParticleEdge[] = [
  makeCycleEdge("p-context", "context", HUB_TO_CONTEXT_X, CONTEXT_TOP_X, 0),
  makeCycleEdge("p-warehouse", "warehouse", HUB_TO_WAREHOUSE_X, WAREHOUSE_TOP_X, 0.5),
];

const nodeTypes = {
  agent: AgentNodeView,
  hub: HubNodeView,
  target: TargetNodeView,
};

const edgeTypes = {
  particle: ParticleEdgeView,
};

const edges = [...flowEdges, ...particleEdges];

export function ProductRuntime() {
  return (
    <section
      className="not-prose my-12 w-full max-w-full min-w-0 space-y-5"
      aria-labelledby="runtime-title"
    >
      <div className="max-w-3xl">
        <h2
          id="runtime-title"
          className="text-xl font-semibold tracking-normal text-fd-foreground sm:text-2xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          How serving works
        </h2>
        <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
          At runtime, agents reach ktx through MCP. ktx searches the context
          layer, returns approved metrics, and compiles them into read-only SQL
          the warehouse runs.
        </p>
      </div>

      <article
        className="max-w-full min-w-0 overflow-hidden rounded-lg border border-fd-border bg-fd-card shadow-sm"
        aria-label="ktx serving flow from an agent request to a governed answer"
      >
        <div className="border-b border-fd-border bg-fd-muted/35 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-fd-primary">
            Serving flow
          </p>
          <h3
            className="mt-1 text-base font-semibold tracking-normal text-fd-foreground sm:text-lg"
            style={{ fontFamily: "var(--font-display)" }}
          >
            From an agent request to a governed answer
          </h3>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-fd-muted-foreground">
            The agent asks in plain language. ktx is the only thing that touches
            the context layer and the warehouse, and every database connection
            is read-only.
          </p>
        </div>

        <FlowCanvas
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          canvasStyle={{
            height: "min(620px, 98vw)",
            minHeight: 430,
          }}
          className="runtime-canvas"
          fitViewOptions={{ padding: 0.06 }}
          ariaLabel="ktx serving flow diagram"
        />
      </article>
      <style>{`
        .runtime-canvas .runtime-particle {
          pointer-events: none;
          filter: drop-shadow(0 0 6px currentColor);
        }
        @media (prefers-reduced-motion: reduce) {
          .runtime-canvas .runtime-particle {
            display: none;
          }
        }
      `}</style>
    </section>
  );
}
