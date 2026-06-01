"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { KtxMascot } from "./mascot";

/** Fixed palette mirrored from the approved SVG diagrams so the exported PNG
 *  is theme-independent (one image that reads on light and dark GitHub). */
export const C = {
  ink: "#1b1b18",
  inkSoft: "#57534e",
  inkMuted: "#8c857f",
  cardBorder: "#e2dfd9",
  engineBg: "#15323a",
  engineBorder: "#23474f",
  cyan: "#55dced",
  stepNum: "#06262c",
  stepTitle: "#f3f1ec",
  stepDesc: "#9fb6bc",
  hubRow: "#eef4f5",
  chipBg: "#faf9f6",
  chipBorder: "#e7e5e4",
  teal: "#0e7490",
  emerald: "#059669",
  orange: "#f97316",
  amber: "#d97706",
  slate: "#334155",
  neutral: "#94a3b8",
} as const;

const DISPLAY = "var(--font-display), system-ui, sans-serif";
const BODY = "var(--font-inter), system-ui, sans-serif";
const MONO = "var(--font-mono), ui-monospace, monospace";

const CARD_SHADOW = "0 3px 12px rgba(27, 49, 57, 0.10)";
const ENGINE_SHADOW = "0 6px 22px rgba(2, 12, 15, 0.30)";

/** ktx logo mascot size, shared by the engine and hub headers. */
const LOGO_SIZE = 56;

type HandleSpec = {
  side: "left" | "right";
  type: "source" | "target";
  id: string;
  top?: string;
};

function Handles({ specs }: { specs?: HandleSpec[] }) {
  if (!specs) return null;
  return (
    <>
      {specs.map((h) => (
        <Handle
          key={`${h.type}-${h.id}`}
          id={h.id}
          type={h.type}
          position={h.side === "left" ? Position.Left : Position.Right}
          isConnectable={false}
          style={{
            opacity: 0,
            border: 0,
            background: "transparent",
            ...(h.top ? { top: h.top } : {}),
          }}
        />
      ))}
    </>
  );
}

/* ------------------------------- Card node ------------------------------- */

type CardRow =
  | { kind: "title"; text: string }
  | { kind: "mono"; text: string; color: string }
  | { kind: "desc"; text: string }
  | { kind: "muted"; text: string }
  | { kind: "chips"; items: string[] }
  | { kind: "badge"; text: string; bg: string; border: string; color: string };

type CardData = {
  width: number;
  height: number;
  accent: string;
  align?: "center";
  rows: CardRow[];
  handles?: HandleSpec[];
};

function gapFor(kind: CardRow["kind"], prev?: CardRow["kind"]): number {
  if (!prev) return 0;
  if (kind === "desc" && prev === "desc") return 3;
  if (kind === "mono" && prev === "mono") return 2;
  if (kind === "title") return 6;
  return 10;
}

function CardRowView({ row }: { row: CardRow }) {
  switch (row.kind) {
    case "title":
      return (
        <span
          style={{
            fontFamily: DISPLAY,
            fontWeight: 700,
            fontSize: 26,
            lineHeight: 1.15,
            color: C.ink,
          }}
        >
          {row.text}
        </span>
      );
    case "mono":
      return (
        <span
          style={{
            fontFamily: MONO,
            fontWeight: 700,
            fontSize: 18,
            lineHeight: 1.4,
            color: row.color,
          }}
        >
          {row.text}
        </span>
      );
    case "desc":
      return (
        <span
          style={{
            fontFamily: BODY,
            fontWeight: 500,
            fontSize: 17,
            lineHeight: 1.45,
            color: C.inkSoft,
          }}
        >
          {row.text}
        </span>
      );
    case "muted":
      return (
        <span
          style={{
            fontFamily: BODY,
            fontWeight: 500,
            fontSize: 14,
            lineHeight: 1.4,
            color: C.inkMuted,
          }}
        >
          {row.text}
        </span>
      );
    case "chips":
      return (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {row.items.map((c) => (
            <span
              key={c}
              style={{
                fontFamily: BODY,
                fontWeight: 600,
                fontSize: 14,
                color: C.inkSoft,
                background: C.chipBg,
                border: `1px solid ${C.chipBorder}`,
                borderRadius: 6,
                padding: "4px 10px",
              }}
            >
              {c}
            </span>
          ))}
        </div>
      );
    case "badge":
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            borderRadius: 14,
            padding: "3px 12px",
            fontFamily: BODY,
            fontWeight: 700,
            fontSize: 14,
            background: row.bg,
            border: `1px solid ${row.border}`,
            color: row.color,
          }}
        >
          {row.text}
        </span>
      );
  }
}

function CardNode({ data }: NodeProps<Node<CardData>>) {
  const center = data.align === "center";
  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        position: "relative",
        background: "#ffffff",
        border: `1px solid ${C.cardBorder}`,
        borderRadius: 10,
        boxShadow: CARD_SHADOW,
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        alignItems: center ? "center" : "flex-start",
        justifyContent: center ? "center" : "flex-start",
        textAlign: center ? "center" : "left",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 0,
          left: 2,
          right: 2,
          height: 4,
          borderRadius: 2,
          background: data.accent,
        }}
      />
      <Handles specs={data.handles} />
      {data.rows.map((row, i) => (
        <div
          key={i}
          style={{ marginTop: gapFor(row.kind, data.rows[i - 1]?.kind) }}
        >
          <CardRowView row={row} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ Engine node ------------------------------ */

type EngineStep = { n: number; title: string; desc: string };

type EngineData = {
  width: number;
  height: number;
  steps: EngineStep[];
  handles?: HandleSpec[];
};

function EngineNode({ data }: NodeProps<Node<EngineData>>) {
  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        position: "relative",
        background: C.engineBg,
        border: `1px solid ${C.engineBorder}`,
        borderRadius: 14,
        boxShadow: ENGINE_SHADOW,
        padding: "24px 24px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 0,
          left: 2,
          right: 2,
          height: 4,
          borderRadius: 2,
          background: C.cyan,
        }}
      />
      <Handles specs={data.handles} />
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <KtxMascot variant="dark" size={LOGO_SIZE} />
        <span
          style={{
            fontFamily: DISPLAY,
            fontWeight: 700,
            fontSize: 30,
            color: C.stepTitle,
          }}
        >
          ktx
        </span>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-around",
          marginTop: 6,
        }}
      >
        {data.steps.map((s) => (
          <div
            key={s.n}
            style={{ display: "flex", alignItems: "center", gap: 18 }}
          >
            <span
              style={{
                flex: "none",
                width: 44,
                height: 44,
                borderRadius: "50%",
                background: C.cyan,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: DISPLAY,
                fontWeight: 800,
                fontSize: 22,
                color: C.stepNum,
              }}
            >
              {s.n}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span
                style={{
                  fontFamily: DISPLAY,
                  fontWeight: 700,
                  fontSize: 24,
                  lineHeight: 1.1,
                  color: C.stepTitle,
                }}
              >
                {s.title}
              </span>
              <span
                style={{
                  fontFamily: BODY,
                  fontWeight: 500,
                  fontSize: 16,
                  lineHeight: 1.3,
                  color: C.stepDesc,
                }}
              >
                {s.desc}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------- Hub node ------------------------------- */

type HubData = {
  width: number;
  height: number;
  rows: string[];
  handles?: HandleSpec[];
};

function HubNode({ data }: NodeProps<Node<HubData>>) {
  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        position: "relative",
        background: C.engineBg,
        border: `1px solid ${C.engineBorder}`,
        borderRadius: 14,
        boxShadow: ENGINE_SHADOW,
        padding: "24px 24px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 0,
          left: 2,
          right: 2,
          height: 4,
          borderRadius: 2,
          background: C.cyan,
        }}
      />
      <Handles specs={data.handles} />
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <KtxMascot variant="dark" size={LOGO_SIZE} />
        <span
          style={{
            fontFamily: DISPLAY,
            fontWeight: 700,
            fontSize: 30,
            color: C.stepTitle,
          }}
        >
          ktx
        </span>
      </div>
      <div
        style={{
          marginTop: 22,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {data.rows.map((r) => (
          <div key={r} style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span
              style={{
                flex: "none",
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: C.cyan,
              }}
            />
            <span
              style={{
                fontFamily: BODY,
                fontWeight: 600,
                fontSize: 19,
                color: C.hubRow,
              }}
            >
              {r}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------- Title node ------------------------------ */

type TitleData = { width: number; eyebrow: string; title: string };

function TitleNode({ data }: NodeProps<Node<TitleData>>) {
  return (
    <div
      style={{
        width: data.width,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span
        style={{
          fontFamily: BODY,
          fontSize: 19,
          fontWeight: 800,
          letterSpacing: 2,
          textTransform: "uppercase",
          color: C.teal,
        }}
      >
        {data.eyebrow}
      </span>
      <span
        style={{
          fontFamily: DISPLAY,
          fontSize: 24,
          fontWeight: 600,
          color: C.inkMuted,
        }}
      >
        {data.title}
      </span>
    </div>
  );
}

export const nodeTypes = {
  card: CardNode,
  engine: EngineNode,
  hub: HubNode,
  title: TitleNode,
};
