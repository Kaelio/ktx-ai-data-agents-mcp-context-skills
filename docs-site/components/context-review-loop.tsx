"use client";

import {
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
} from "@xyflow/react";

import { FlowCanvas } from "./flow-canvas";

type SourcesNodeData = {
  variant: "sources";
  badge: string;
  title: string;
  caption: string;
  items: Array<{ label: string; color: string }>;
};

type IngestNodeData = {
  variant: "ingest";
  badge: string;
  title: string;
  command: string;
  caption: string;
};

type DiffFileLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string };
type DiffFile = {
  path: string;
  accent: string;
  added: number;
  removed: number;
  lines: DiffFileLine[];
};

type DiffNodeData = {
  variant: "diff";
  badge: string;
  title: string;
  caption: string;
  branch: string;
  files: DiffFile[];
};

type ReviewNodeData = {
  variant: "review";
  badge: string;
  title: string;
  caption: string;
  checks: string[];
};

type MergedNodeData = {
  variant: "merged";
  badge: string;
  title: string;
  caption: string;
  paths: Array<{ label: string; color: string }>;
};

type SourcesNode = Node<SourcesNodeData, "sources">;
type IngestNode = Node<IngestNodeData, "ingest">;
type DiffNode = Node<DiffNodeData, "diff">;
type ReviewNode = Node<ReviewNodeData, "review">;
type MergedNode = Node<MergedNodeData, "merged">;
type FlowNode = SourcesNode | IngestNode | DiffNode | ReviewNode | MergedNode;

const NODE_W = 420;
const STD_H = 196;
const DIFF_H = 472;

const CENTER_X = 220;
const GAP = 72;

const SOURCES_Y = 16;
const INGEST_Y = SOURCES_Y + STD_H + GAP;
const DIFF_Y = INGEST_Y + STD_H + GAP;
const REVIEW_Y = DIFF_Y + DIFF_H + GAP;
const MERGED_Y = REVIEW_Y + STD_H + GAP;
const CANVAS_BOTTOM = MERGED_Y + STD_H + 16;

const FORWARD_STROKE = "#0891b2";
const FEEDBACK_STROKE = "#94a3b8";

const sourcesNode: SourcesNode = {
  id: "sources",
  type: "sources",
  position: { x: CENTER_X, y: SOURCES_Y },
  data: {
    variant: "sources",
    badge: "1 · evidence",
    title: "Data stack",
    caption: "Connectors scan warehouses, modeling code, BI tools, and notes.",
    items: [
      { label: "warehouse", color: "#3b82f6" },
      { label: "dbt", color: "#f59e0b" },
      { label: "Metabase", color: "#f97316" },
      { label: "Notion", color: "#10b981" },
    ],
  },
  draggable: false,
  selectable: false,
};

const ingestNode: IngestNode = {
  id: "ingest",
  type: "ingest",
  position: { x: CENTER_X, y: INGEST_Y },
  data: {
    variant: "ingest",
    badge: "2 · run",
    title: "ktx ingest",
    command: "ktx ingest --all",
    caption:
      "Reconciles new evidence with the accepted YAML and Markdown already on disk.",
  },
  draggable: false,
  selectable: false,
};

const diffNode: DiffNode = {
  id: "diff",
  type: "diff",
  position: { x: CENTER_X, y: DIFF_Y },
  data: {
    variant: "diff",
    badge: "3 · diff",
    title: "Branch diff",
    caption: "Every decision lands as a YAML or Markdown line.",
    branch: "ingest/nightly",
    files: [
      {
        path: "semantic-layer/warehouse/orders.yaml",
        accent: "#3b82f6",
        added: 4,
        removed: 1,
        lines: [
          { kind: "hunk", text: "@@ measures @@" },
          { kind: "ctx", text: "  - name: revenue" },
          { kind: "del", text: "    expr: sum(amount)" },
          { kind: "add", text: "    expr: sum(amount - refund_amount)" },
          { kind: "add", text: "  - name: net_orders" },
          { kind: "add", text: "    expr: count(distinct id)" },
        ],
      },
      {
        path: "wiki/global/revenue.md",
        accent: "#10b981",
        added: 2,
        removed: 0,
        lines: [
          { kind: "hunk", text: "@@ Net revenue @@" },
          { kind: "add", text: "Excludes refunds and test accounts." },
          { kind: "add", text: "sl_refs: [warehouse.orders]" },
        ],
      },
    ],
  },
  draggable: false,
  selectable: false,
};

const reviewNode: ReviewNode = {
  id: "review",
  type: "review",
  position: { x: CENTER_X, y: REVIEW_Y },
  data: {
    variant: "review",
    badge: "4 · review",
    title: "PR review",
    caption: "Analysts approve, edit, or reject like any pull request.",
    checks: ["joins are safe", "measures match policy", "wiki cites evidence"],
  },
  draggable: false,
  selectable: false,
};

const mergedNode: MergedNode = {
  id: "merged",
  type: "merged",
  position: { x: CENTER_X, y: MERGED_Y },
  data: {
    variant: "merged",
    badge: "5 · merged",
    title: "Accepted context",
    caption: "Merged files become the trusted layer agents read at runtime.",
    paths: [
      { label: "semantic-layer/", color: "#3b82f6" },
      { label: "wiki/", color: "#10b981" },
    ],
  },
  draggable: false,
  selectable: false,
};

const nodes: FlowNode[] = [
  sourcesNode,
  ingestNode,
  diffNode,
  reviewNode,
  mergedNode,
];

const arrowMarker = (color: string) => ({
  type: MarkerType.ArrowClosed,
  color,
  width: 14,
  height: 14,
});

const forwardLabelStyle = {
  fontSize: 11,
  fontWeight: 600,
  fill: "var(--color-fd-muted-foreground)",
  letterSpacing: "0.02em",
} as const;

const forwardLabelBg = {
  fill: "var(--color-fd-background)",
  stroke: "var(--color-fd-border)",
  strokeWidth: 1,
} as const;

const edges = [
  {
    id: "sources-ingest",
    source: "sources",
    sourceHandle: "bottom",
    target: "ingest",
    targetHandle: "top",
    type: "straight" as const,
    label: "scan",
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    labelStyle: forwardLabelStyle,
    labelBgStyle: forwardLabelBg,
    style: { stroke: FORWARD_STROKE, strokeWidth: 1.75 },
    markerEnd: arrowMarker(FORWARD_STROKE),
  },
  {
    id: "ingest-diff",
    source: "ingest",
    sourceHandle: "bottom",
    target: "diff",
    targetHandle: "top",
    type: "straight" as const,
    label: "propose files",
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    labelStyle: forwardLabelStyle,
    labelBgStyle: forwardLabelBg,
    style: { stroke: FORWARD_STROKE, strokeWidth: 1.75 },
    markerEnd: arrowMarker(FORWARD_STROKE),
  },
  {
    id: "diff-review",
    source: "diff",
    sourceHandle: "bottom",
    target: "review",
    targetHandle: "top",
    type: "straight" as const,
    label: "open PR",
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    labelStyle: forwardLabelStyle,
    labelBgStyle: forwardLabelBg,
    style: { stroke: FORWARD_STROKE, strokeWidth: 1.75 },
    markerEnd: arrowMarker(FORWARD_STROKE),
  },
  {
    id: "review-merged",
    source: "review",
    sourceHandle: "bottom",
    target: "merged",
    targetHandle: "top",
    type: "straight" as const,
    label: "merge",
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    labelStyle: forwardLabelStyle,
    labelBgStyle: forwardLabelBg,
    style: { stroke: FORWARD_STROKE, strokeWidth: 1.75 },
    markerEnd: arrowMarker(FORWARD_STROKE),
  },
  {
    id: "merged-sources",
    source: "merged",
    sourceHandle: "right",
    target: "sources",
    targetHandle: "right",
    type: "smoothstep" as const,
    pathOptions: { offset: 64, borderRadius: 18 },
    style: {
      stroke: FEEDBACK_STROKE,
      strokeWidth: 1.5,
      strokeDasharray: "5 5",
    },
    markerEnd: arrowMarker(FEEDBACK_STROKE),
  },
];

function BadgePill({
  tone,
  children,
}: {
  tone: "neutral" | "primary" | "review" | "merged";
  children: React.ReactNode;
}) {
  const cls =
    tone === "primary"
      ? "border-cyan-300/70 bg-cyan-50 text-cyan-800 dark:border-cyan-400/40 dark:bg-cyan-400/15 dark:text-cyan-100"
      : tone === "review"
        ? "border-fuchsia-300/70 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-400/40 dark:bg-fuchsia-400/15 dark:text-fuchsia-100"
        : tone === "merged"
          ? "border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-400/15 dark:text-emerald-100"
          : "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-600/60 dark:bg-slate-700/40 dark:text-slate-200";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 font-mono text-[13px] font-semibold uppercase tracking-[0.06em] ${cls}`}
      style={{ lineHeight: "20px", paddingBlock: 0 }}
    >
      {children}
    </span>
  );
}

function FlowHandles({ noTop = false }: { noTop?: boolean }) {
  return (
    <>
      {!noTop ? (
        <Handle
          id="top"
          type="target"
          position={Position.Top}
          className="!opacity-0"
        />
      ) : null}
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        className="!opacity-0"
      />
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        className="!opacity-0"
      />
      <Handle
        id="right-target"
        type="target"
        position={Position.Right}
        className="!opacity-0"
      />
    </>
  );
}

function SourcesHandles() {
  return (
    <>
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        className="!opacity-0"
      />
      <Handle
        id="right"
        type="target"
        position={Position.Right}
        className="!opacity-0"
      />
    </>
  );
}

function SourcesNodeView({ data }: NodeProps<SourcesNode>) {
  return (
    <div
      style={{ width: NODE_W, height: STD_H }}
      className="flex flex-col rounded-md border border-fd-border bg-fd-card px-4 py-3.5 shadow-sm"
    >
      <SourcesHandles />
      <BadgePill tone="neutral">{data.badge}</BadgePill>
      <p className="mt-2 text-[19px] font-semibold leading-7 text-fd-foreground">
        {data.title}
      </p>
      <p className="mt-1.5 text-[15px] leading-6 text-fd-muted-foreground">
        {data.caption}
      </p>
      <div className="mt-auto flex flex-wrap gap-1.5 pt-2.5">
        {data.items.map((item) => (
          <span
            key={item.label}
            className="inline-flex items-center gap-1.5 rounded border border-fd-border bg-fd-background px-2 py-0.5 text-[13px] leading-5 text-fd-muted-foreground"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 flex-none rounded-full"
              style={{ background: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function IngestNodeView({ data }: NodeProps<IngestNode>) {
  return (
    <div
      style={{ width: NODE_W, height: STD_H }}
      className="relative flex flex-col rounded-md border border-cyan-300/40 bg-[#0f1f23] px-4 py-3.5 text-white shadow-sm dark:bg-[#0b181b]"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-md"
        style={{ background: FORWARD_STROKE }}
      />
      <FlowHandles />
      <div className="flex items-center gap-2.5">
        <BadgePill tone="primary">{data.badge}</BadgePill>
        <p className="text-[19px] font-semibold leading-7 text-white">
          {data.title}
        </p>
      </div>
      <span
        className="mt-2 inline-flex w-fit items-center whitespace-pre rounded-sm border border-cyan-100/15 bg-white/[0.08] px-2 py-0.5 font-mono text-[14px] leading-5 text-cyan-100"
        style={{
          fontVariantLigatures: "none",
          fontFeatureSettings: '"liga" 0, "calt" 0',
        }}
      >
        {`$ ${data.command}`}
      </span>
      <p className="mt-2 text-[15px] leading-6 text-cyan-50/80">
        {data.caption}
      </p>
    </div>
  );
}

function DiffLine({ line }: { line: DiffFileLine }) {
  if (line.kind === "hunk") {
    return (
      <div className="bg-fd-muted/40 px-2.5 py-1 font-mono text-[12px] uppercase tracking-[0.06em] text-fd-muted-foreground">
        {line.text}
      </div>
    );
  }
  const symbol = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const cls =
    line.kind === "add"
      ? "bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
      : line.kind === "del"
        ? "bg-rose-500/8 text-rose-700 dark:text-rose-300"
        : "text-fd-muted-foreground";
  return (
    <div
      className={`flex gap-1.5 px-2.5 py-px font-mono text-[13px] leading-5 ${cls}`}
    >
      <span aria-hidden="true" className="w-2.5 flex-none text-center opacity-70">
        {symbol}
      </span>
      <span className="min-w-0 truncate">{line.text}</span>
    </div>
  );
}

function DiffFileBlock({ file }: { file: DiffFile }) {
  return (
    <div className="overflow-hidden rounded-sm border border-fd-border bg-fd-background">
      <div
        className="flex items-center gap-2 border-b border-fd-border px-2.5 py-1.5"
        style={{ borderTop: `2px solid ${file.accent}` }}
      >
        <span
          className="truncate font-mono text-[14px] font-semibold tracking-tight"
          style={{ color: file.accent }}
        >
          {file.path}
        </span>
        <span className="ml-auto flex-none font-mono text-[12px] tabular-nums text-emerald-600 dark:text-emerald-400">
          +{file.added}
        </span>
        {file.removed > 0 ? (
          <span className="flex-none font-mono text-[12px] tabular-nums text-rose-600 dark:text-rose-400">
            -{file.removed}
          </span>
        ) : null}
      </div>
      <div className="py-1">
        {file.lines.map((line, idx) => (
          <DiffLine key={idx} line={line} />
        ))}
      </div>
    </div>
  );
}

function DiffNodeView({ data }: NodeProps<DiffNode>) {
  return (
    <div
      style={{ width: NODE_W, height: DIFF_H }}
      className="flex flex-col rounded-md border-2 border-fd-primary/45 bg-fd-card px-4 py-3.5 shadow-md"
    >
      <FlowHandles />
      <div className="flex items-center gap-2.5">
        <BadgePill tone="primary">{data.badge}</BadgePill>
        <p className="text-[19px] font-semibold leading-7 text-fd-foreground">
          {data.title}
        </p>
        <span
          className="ml-auto inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded border border-fd-border bg-fd-background px-2 py-0.5 font-mono text-[13px] leading-5 text-fd-muted-foreground"
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="6" cy="6" r="2.25" />
            <circle cx="6" cy="18" r="2.25" />
            <circle cx="18" cy="6" r="2.25" />
            <path d="M6 8.5v7" />
            <path d="M6 18c0-6 12-6 12-9.5" />
          </svg>
          {data.branch}
        </span>
      </div>
      <p className="mt-1.5 text-[15px] leading-6 text-fd-muted-foreground">
        {data.caption}
      </p>
      <div className="mt-2.5 flex min-h-0 flex-1 flex-col gap-2">
        {data.files.map((file) => (
          <DiffFileBlock key={file.path} file={file} />
        ))}
      </div>
    </div>
  );
}

function ReviewNodeView({ data }: NodeProps<ReviewNode>) {
  return (
    <div
      style={{ width: NODE_W, height: STD_H }}
      className="flex flex-col rounded-md border border-fd-border bg-fd-card px-4 py-3.5 shadow-sm"
    >
      <FlowHandles />
      <div className="flex items-center gap-2.5">
        <BadgePill tone="review">{data.badge}</BadgePill>
        <p className="text-[19px] font-semibold leading-7 text-fd-foreground">
          {data.title}
        </p>
      </div>
      <p className="mt-1.5 text-[15px] leading-6 text-fd-muted-foreground">
        {data.caption}
      </p>
      <ul className="mt-auto flex flex-wrap gap-x-4 gap-y-1.5 pt-2.5">
        {data.checks.map((check) => (
          <li
            key={check}
            className="inline-flex items-center gap-1.5 text-[13px] leading-5 text-fd-muted-foreground"
          >
            <svg
              aria-hidden="true"
              className="h-3.5 w-3.5 flex-none text-fuchsia-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 12 10 18 20 6" />
            </svg>
            <span>{check}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MergedNodeView({ data }: NodeProps<MergedNode>) {
  return (
    <div
      style={{ width: NODE_W, height: STD_H }}
      className="flex flex-col rounded-md border border-emerald-300/55 bg-fd-card px-4 py-3.5 shadow-sm"
    >
      <FlowHandles />
      <div className="flex items-center gap-2.5">
        <BadgePill tone="merged">{data.badge}</BadgePill>
        <p className="text-[19px] font-semibold leading-7 text-fd-foreground">
          {data.title}
        </p>
      </div>
      <p className="mt-1.5 text-[15px] leading-6 text-fd-muted-foreground">
        {data.caption}
      </p>
      <div className="mt-auto flex flex-wrap gap-4 pt-2.5">
        {data.paths.map((path) => (
          <span
            key={path.label}
            className="inline-flex items-center gap-1.5 font-mono text-[15px] font-semibold tracking-tight"
            style={{ color: path.color }}
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 flex-none rounded-full"
              style={{ background: path.color }}
            />
            {path.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const nodeTypes = {
  sources: SourcesNodeView,
  ingest: IngestNodeView,
  diff: DiffNodeView,
  review: ReviewNodeView,
  merged: MergedNodeView,
};

export function ContextReviewLoop() {
  return (
    <section
      id="review-loop"
      className="not-prose my-10 w-full max-w-full min-w-0 scroll-mt-24"
      aria-labelledby="review-loop-title"
    >
      <article
        className="max-w-full min-w-0 overflow-hidden rounded-lg border border-fd-border bg-fd-card shadow-sm"
        aria-label="The ktx context review loop"
      >
        <div className="border-b border-fd-border bg-fd-muted/35 px-5 py-4">
          <a
            href="#review-loop"
            className="group/anchor inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fd-primary transition-colors hover:text-fd-primary/80"
          >
            The review loop
            <span
              aria-hidden="true"
              className="opacity-0 transition-opacity duration-150 group-hover/anchor:opacity-100 group-focus-visible/anchor:opacity-100"
            >
              #
            </span>
          </a>
          <h3
            id="review-loop-title"
            className="mt-1 text-base font-semibold tracking-normal text-fd-foreground sm:text-lg"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Every ingest is a diff you can refuse
          </h3>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-fd-muted-foreground">
            Evidence becomes file changes. File changes become a PR. The PR
            merges into the layer agents will read tomorrow, and what you
            merged today becomes the baseline for the next run.
          </p>
          <p className="mt-2 inline-flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-fd-muted-foreground">
            <span
              aria-hidden="true"
              className="inline-block h-px w-6"
              style={{
                borderTop: `1.5px dashed ${FEEDBACK_STROKE}`,
              }}
            />
            dashed line: merged files feed the next ingest
          </p>
        </div>

        <FlowCanvas
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          canvasStyle={{
            height: "min(1080px, 160vw)",
            minHeight: 760,
          }}
          translateExtent={[
            [-160, -120],
            [CENTER_X + NODE_W + 320, CANVAS_BOTTOM + 120],
          ]}
          ariaLabel="ktx context review loop diagram"
        />
      </article>
    </section>
  );
}
