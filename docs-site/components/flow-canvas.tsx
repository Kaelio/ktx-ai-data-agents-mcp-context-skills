"use client";

import { useCallback, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type EdgeTypes,
  type FitViewOptions,
  type Node,
  type NodeTypes,
  type OnInit,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type FlowCanvasProps<TNode extends Node, TEdge extends Edge> = {
  nodes: TNode[];
  edges: TEdge[];
  nodeTypes?: NodeTypes;
  edgeTypes?: EdgeTypes;
  /** Inline style for the canvas wrapper (height, minHeight, etc.). */
  canvasStyle: React.CSSProperties;
  /** Extra class on the canvas wrapper (the `flow-canvas` class is always
   *  applied). Use it to scope per-diagram styles. */
  className?: string;
  fitViewOptions?: FitViewOptions<TNode>;
  maxZoom?: number;
  translateExtent?: [[number, number], [number, number]];
  ariaLabel?: string;
};

const DEFAULT_FIT_VIEW = { padding: 0.05 } satisfies FitViewOptions;

/**
 * Shared ReactFlow wrapper for docs diagrams.
 *
 * Behavior:
 * - Drag-to-pan, pinch-to-zoom, double-click-to-zoom.
 * - Scroll wheel passes through to the page (zoomOnScroll/panOnScroll off).
 * - On mount, the view is fitted and `minZoom` is locked to the fitted zoom
 *   so the user can zoom in but not out beyond the initial framing.
 * - Nodes are non-draggable, non-selectable, non-focusable — the diagram is
 *   a static read-only artifact.
 * - Common CSS lives in `global.css` under the `.flow-canvas` selector; the
 *   per-diagram `className` adds anything else specific to that diagram.
 */
export function FlowCanvas<TNode extends Node, TEdge extends Edge>({
  nodes,
  edges,
  nodeTypes,
  edgeTypes,
  canvasStyle,
  className,
  fitViewOptions = DEFAULT_FIT_VIEW,
  maxZoom = 1.5,
  translateExtent,
  ariaLabel,
}: FlowCanvasProps<TNode, TEdge>) {
  const [minZoom, setMinZoom] = useState(0.15);
  const handleInit = useCallback<OnInit<TNode, TEdge>>(
    (instance) => {
      requestAnimationFrame(() => {
        void instance.fitView(fitViewOptions).then(() => {
          setMinZoom(instance.getZoom());
        });
      });
    },
    [fitViewOptions],
  );

  return (
    <div
      className={`flow-canvas relative bg-fd-background ${className ?? ""}`}
      style={canvasStyle}
      aria-label={ariaLabel}
    >
      <div className="pointer-events-none absolute right-2.5 top-2.5 z-10 rounded border border-fd-border/50 bg-white/30 px-1.5 py-px font-mono text-[9.5px] font-medium uppercase tracking-[0.06em] text-fd-muted-foreground shadow-sm backdrop-blur-sm dark:bg-white/10">
        Drag to pan · ⌘/Ctrl + scroll to zoom
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={handleInit}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnDrag
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick
        preventScrolling={false}
        minZoom={minZoom}
        maxZoom={maxZoom}
        translateExtent={translateExtent}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="var(--color-fd-border)"
        />
        <Controls
          showInteractive={false}
          position="bottom-right"
          aria-label="Zoom and fit-view controls"
        />
      </ReactFlow>
    </div>
  );
}
