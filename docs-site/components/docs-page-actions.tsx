"use client";

import { useState } from "react";

type Props = {
  mdxSource: string;
};

function stripFrontmatter(source: string) {
  return source.trim().replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

export function DocsPageActions({ mdxSource }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(stripFrontmatter(mdxSource));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied - fail silently
    }
  };

  return (
    <div className="not-prose flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex h-8 items-center rounded-md border border-fd-border bg-fd-background px-3 font-medium text-fd-muted-foreground transition-colors hover:border-fd-primary/40 hover:text-fd-foreground data-[state=copied]:border-emerald-500/40 data-[state=copied]:text-emerald-600"
        data-state={copied ? "copied" : "idle"}
      >
        {copied ? "Copied" : "Copy as Markdown"}
      </button>
    </div>
  );
}
