import { describe, expect, it } from 'vitest';
import {
  deletedRawPathsScenario,
  flaggedFallbackScenario,
  postSaveSecretFailureScenario,
  successfulReplayScenario,
  validationRevertScenario,
} from './acceptance-fixtures.js';
import { renderMemoryFlowReplay } from './render.js';
import { buildMemoryFlowViewModel } from './view-model.js';

function renderScenario(input = successfulReplayScenario(), terminalWidth = 140): string {
  return renderMemoryFlowReplay(buildMemoryFlowViewModel(input), { terminalWidth });
}

describe('memory-flow acceptance scenarios', () => {
  it('renders a completed replay with a clear saved-memory completion line', () => {
    const output = renderScenario(successfulReplayScenario());

    expect(output).toContain('KTX memory flow  warehouse/metricflow  done');
    expect(output).toContain('Saved 3 memories from 4 raw files: 2 wiki pages, 1 SL updates.');
    expect(output).toContain('Commit: abc12345  Run: run-success  Report: ingest-report.json');
  });

  it('renders deleted raw paths as eviction candidates without listing every raw path by default', () => {
    const output = renderScenario(deletedRawPathsScenario());

    expect(output).toContain('2 deletions');
    expect(output).toContain('Eviction candidates: 2');
    expect(output).not.toContain('/full/local/path/private/orders-2024.sql');
  });

  it('renders invalid semantic-layer writes as reverted, not saved', () => {
    const output = renderScenario(validationRevertScenario());

    expect(output).toContain('orders reverted: semantic-layer validation failed for warehouse.orders');
    expect(output).toContain('Invalid semantic-layer writes were not saved.');
    expect(output).not.toContain('Saved 1 memories');
  });

  it('renders flagged fallbacks in gates details', () => {
    const output = renderScenario(flaggedFallbackScenario());

    expect(output).toContain('0 conflict, 1 fallback');
    expect(output).toContain('Flagged fallbacks: 1');
  });

  it('renders no ANSI color codes in the text fallback for terminals without color support', () => {
    const output = renderScenario(successfulReplayScenario(), 80);

    expect(output).toContain('KTX memory flow  warehouse/metricflow  done');
    expect(output).not.toMatch(/\u001b\[[0-9;]*m/);
  });

  it('redacts secrets in visible post-save failure text', () => {
    const output = renderScenario(postSaveSecretFailureScenario());

    expect(output).toContain('Post-save error: index refresh failed https://[redacted] token=[redacted]');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('https://example.com/private');
  });
});
