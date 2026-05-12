"use client";

import { useState } from "react";

type CopyState = "idle" | "copied" | "error";

type Props = {
  markdownUrl: string;
  mdxSource: string;
};

export function DocsPageActions({ markdownUrl, mdxSource }: Props) {
  return (
    <div className="not-prose mt-4 mb-8 flex flex-wrap items-center gap-2 border-b border-fd-border pb-6 text-xs">
      <CopyMarkdownButton markdownUrl={markdownUrl} />
      <a
        href={markdownUrl}
        className="inline-flex h-8 items-center rounded-md border border-fd-border bg-fd-background px-3 font-medium text-fd-muted-foreground transition-colors hover:border-fd-primary/40 hover:text-fd-foreground"
      >
        View MD
      </a>
      <CopyTextButton label="Copy MDX" text={mdxSource} />
    </div>
  );
}

function CopyMarkdownButton({ markdownUrl }: { markdownUrl: string }) {
  const [state, setState] = useState<CopyState>("idle");

  const onClick = async () => {
    try {
      const response = await fetch(markdownUrl, {
        headers: { Accept: "text/markdown" },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch ${markdownUrl}`);
      }

      await navigator.clipboard.writeText(await response.text());
      flash(setState, "copied");
    } catch {
      flash(setState, "error");
    }
  };

  return (
    <ActionButton
      label={labelForState(state, "Copy MD")}
      onClick={onClick}
      state={state}
    />
  );
}

function CopyTextButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<CopyState>("idle");

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      flash(setState, "copied");
    } catch {
      flash(setState, "error");
    }
  };

  return (
    <ActionButton
      label={labelForState(state, label)}
      onClick={onClick}
      state={state}
    />
  );
}

function ActionButton({
  label,
  onClick,
  state,
}: {
  label: string;
  onClick: () => void;
  state: CopyState;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center rounded-md border border-fd-border bg-fd-background px-3 font-medium text-fd-muted-foreground transition-colors hover:border-fd-primary/40 hover:text-fd-foreground data-[state=copied]:border-emerald-500/40 data-[state=copied]:text-emerald-600 data-[state=error]:border-red-500/40 data-[state=error]:text-red-600"
      data-state={state}
    >
      {label}
    </button>
  );
}

function labelForState(state: CopyState, label: string) {
  if (state === "copied") return "Copied";
  if (state === "error") return "Copy failed";
  return label;
}

function flash(
  setState: (state: CopyState) => void,
  state: Exclude<CopyState, "idle">,
) {
  setState(state);
  window.setTimeout(() => setState("idle"), 1500);
}
