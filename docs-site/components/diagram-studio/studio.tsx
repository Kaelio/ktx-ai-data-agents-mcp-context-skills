"use client";

import "@xyflow/react/dist/style.css";

import { useCallback, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  type Edge,
  getNodesBounds,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { toPng } from "html-to-image";

import {
  ingestionEdges,
  ingestionNodes,
  runtimeEdges,
  runtimeNodes,
} from "./flows";
import { nodeTypes } from "./nodes";

const EXPORT_PADDING = 48;
const EXPORT_PIXEL_RATIO = 2;

function DiagramCanvasInner({
  initialNodes,
  initialEdges,
  fileName,
  height,
  dark,
}: {
  initialNodes: Node[];
  initialEdges: Edge[];
  fileName: string;
  height: number;
  dark: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);
  const { getNodes } = useReactFlow();
  const [busy, setBusy] = useState(false);

  const download = useCallback(async () => {
    const viewport = wrapperRef.current?.querySelector<HTMLElement>(
      ".react-flow__viewport",
    );
    if (!viewport) return;
    setBusy(true);
    try {
      await document.fonts.ready;
      const bounds = getNodesBounds(getNodes());
      const outW = Math.ceil(bounds.width + EXPORT_PADDING * 2);
      const outH = Math.ceil(bounds.height + EXPORT_PADDING * 2);
      const tx = EXPORT_PADDING - bounds.x;
      const ty = EXPORT_PADDING - bounds.y;
      const dataUrl = await toPng(viewport, {
        width: outW,
        height: outH,
        pixelRatio: EXPORT_PIXEL_RATIO,
        // transparent background so one PNG works on light and dark GitHub
        style: {
          width: `${outW}px`,
          height: `${outH}px`,
          transform: `translate(${tx}px, ${ty}px) scale(1)`,
        },
      });
      const link = document.createElement("a");
      link.download = fileName;
      link.href = dataUrl;
      link.click();
    } finally {
      setBusy(false);
    }
  }, [fileName, getNodes]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button
          type="button"
          onClick={download}
          disabled={busy}
          style={btnStyle(busy)}
        >
          {busy ? "Exporting…" : "Download PNG"}
        </button>
      </div>
      <div
        ref={wrapperRef}
        style={{
          height,
          borderRadius: 12,
          border: "1px solid rgba(127,127,127,0.2)",
          background: dark ? "#0d1117" : "#ffffff",
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
          fitViewOptions={{ padding: 0.08 }}
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
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={18}
            size={1}
            color={dark ? "#1f2a30" : "#e6e2db"}
          />
        </ReactFlow>
      </div>
    </div>
  );
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: "var(--font-inter), system-ui, sans-serif",
    fontSize: 13,
    fontWeight: 600,
    padding: "7px 14px",
    borderRadius: 8,
    border: "1px solid #0e7490",
    background: disabled ? "#9bbdc6" : "#0e7490",
    color: "#ffffff",
    cursor: disabled ? "default" : "pointer",
  };
}

function DiagramCanvas(props: {
  initialNodes: Node[];
  initialEdges: Edge[];
  fileName: string;
  height: number;
  dark: boolean;
}) {
  return (
    <ReactFlowProvider>
      <DiagramCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export function DiagramStudio() {
  const [dark, setDark] = useState(false);
  return (
    <main
      style={{
        maxWidth: 1320,
        margin: "0 auto",
        padding: "32px 24px 80px",
        fontFamily: "var(--font-inter), system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontFamily: "var(--font-display), system-ui, sans-serif",
            fontSize: 30,
            fontWeight: 700,
            color: "#1b1b18",
            margin: 0,
          }}
        >
          ktx diagram studio
        </h1>
        <p style={{ color: "#6b6560", marginTop: 6, fontSize: 15 }}>
          Static diagrams. Export is a transparent 2× PNG framed to the node
          bounds — the dark-background toggle is only for previewing.
        </p>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
            fontSize: 14,
            color: "#57534e",
          }}
        >
          <input
            type="checkbox"
            checked={dark}
            onChange={(e) => setDark(e.target.checked)}
          />
          Preview on dark background
        </label>
      </header>

      <section style={{ marginBottom: 40 }}>
        <h2 style={sectionTitle}>1 · Ingestion — building the context layer</h2>
        <DiagramCanvas
          initialNodes={ingestionNodes}
          initialEdges={ingestionEdges}
          fileName="ingestion-flow.png"
          height={560}
          dark={dark}
        />
      </section>

      <section>
        <h2 style={sectionTitle}>2 · Serving — answering agents at runtime</h2>
        <DiagramCanvas
          initialNodes={runtimeNodes}
          initialEdges={runtimeEdges}
          fileName="mcp-runtime-flow.png"
          height={480}
          dark={dark}
        />
      </section>
    </main>
  );
}

const sectionTitle: React.CSSProperties = {
  fontFamily: "var(--font-display), system-ui, sans-serif",
  fontSize: 18,
  fontWeight: 600,
  color: "#1b1b18",
  marginBottom: 12,
};
