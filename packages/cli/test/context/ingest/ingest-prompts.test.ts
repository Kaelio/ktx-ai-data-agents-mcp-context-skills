import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function forbiddenProductPattern() {
  return new RegExp([['Kae', 'lio'].join(''), ['kae', 'lio'].join(''), ['KAE', 'LIO_'].join('')].join('|'));
}

describe('ingest prompt assets', () => {
  it('teaches WorkUnit agents to apply canonical pins before writing contested artifacts', async () => {
    const prompt = await readFile(
      new URL('../../../src/prompts/memory_agent_bundle_ingest_work_unit.md', import.meta.url),
      'utf-8',
    );

    expect(prompt).toContain('<canonical_pins>');
    expect(prompt).toContain('canonicalArtifactKey');
    expect(prompt).toContain('prefer editing the pinned canonical artifact');
    expect(prompt).toContain('Do not create a duplicate contested artifact');
  });

  it('uses product-neutral KTX runtime wording', async () => {
    const prompt = await readFile(
      new URL('../../../src/prompts/memory_agent_bundle_ingest_work_unit.md', import.meta.url),
      'utf-8',
    );

    expect(prompt).toContain('KTX semantic-layer sources and/or knowledge wiki pages');
    expect(prompt).toContain('maps cleanly to KTX');
    expect(prompt).not.toMatch(forbiddenProductPattern());
  });

  it('uses shipped warehouse verification tools in the WorkUnit prompt', async () => {
    const prompt = await readFile(
      new URL('../../../src/prompts/memory_agent_bundle_ingest_work_unit.md', import.meta.url),
      'utf-8',
    );

    expect(prompt).toContain('discover_data');
    expect(prompt).toContain('entity_details');
    expect(prompt).not.toContain('wiki_sl_search');
    expect(prompt).not.toContain('sl_describe_table');
  });

  it('does not route historic-SQL through page-triage prompt examples', async () => {
    const prompt = await readFile(new URL('../../../src/prompts/skills/page_triage_classifier.md', import.meta.url), 'utf-8');

    expect(prompt).not.toContain(['historic_sql', 'template'].join('_'));
    expect(prompt).not.toContain('service_account_only=true AND below the frequency floor');
  });
});
