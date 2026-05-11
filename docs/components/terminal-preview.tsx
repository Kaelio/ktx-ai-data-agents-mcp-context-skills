export function TerminalPreview() {
  return (
    <div className="terminal-frame sheen w-full max-w-[560px]">
      <div className="terminal-head">
        <span className="terminal-dot" style={{ background: "#ff5f57" }} />
        <span className="terminal-dot" style={{ background: "#febc2e" }} />
        <span className="terminal-dot" style={{ background: "#28c840" }} />
        <span className="ml-2 text-[11px] text-zinc-500 font-medium tracking-wide">
          ~/analytics
        </span>
      </div>
      <div className="terminal-body">
        <div>
          <span className="term-prompt">$</span>{" "}
          <span className="term-cmd">ktx setup</span>
        </div>
        <div className="h-2" />
        <div className="term-dim">◆ Welcome to KTX setup</div>
        <div className="term-dim">│</div>
        <div>
          <span className="term-dim">◇</span>{" "}
          <span className="term-key">LLM</span>{" "}
          <span className="term-ok">✓ claude-sonnet-4-6</span>
        </div>
        <div>
          <span className="term-dim">◇</span>{" "}
          <span className="term-key">Embeddings</span>{" "}
          <span className="term-ok">✓ openai · text-embedding-3-small</span>
        </div>
        <div>
          <span className="term-dim">◇</span>{" "}
          <span className="term-key">Database</span>{" "}
          <span className="term-ok">✓ postgres-warehouse · 42 tables</span>
        </div>
        <div>
          <span className="term-dim">◇</span>{" "}
          <span className="term-key">Sources</span>{" "}
          <span className="term-ok">✓ dbt-main · 218 models</span>
        </div>
        <div className="h-2" />
        <div className="term-info">◐ Building context for agents…</div>
        <div className="pl-3 text-[12px] term-dim">
          enriching schema · detecting relationships · ingesting dbt
        </div>
        <div className="h-2" />
        <div className="term-ok">✓ KTX context is ready for agents.</div>
        <div className="h-2" />
        <div>
          <span className="term-prompt">$</span>{" "}
          <span className="term-cmd">ktx serve</span>
          <span className="term-cursor ml-1" />
        </div>
      </div>
    </div>
  );
}
