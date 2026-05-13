import { describe, expect, it, vi } from 'vitest';
import { repairWikiSlRefs } from './wiki-sl-ref-repair.js';

describe('repairWikiSlRefs', () => {
  it('removes missing measure refs while keeping source, measure, segment, and manifest-backed refs', async () => {
    type TestPage = { pageKey: string; frontmatter: Record<string, unknown>; content: string };
    const pages = new Map<string, TestPage>([
      [
        'GLOBAL:accounts-at-risk',
        {
          pageKey: 'accounts-at-risk',
          frontmatter: {
            summary: 'Accounts at risk',
            usage_mode: 'auto',
            sl_refs: [
              'mart_customer_health',
              'mart_customer_health.high_risk_account_count',
              'mart_customer_health.medium_risk_account_count',
              'mart_customer_health.high_risk',
              'int_procurement_qualifying_actions',
            ],
          },
          content: 'Risk context.',
        },
      ],
    ]);
    const wikiService = {
      readPage: vi.fn(async (scope: string, _scopeId: string | null, key: string) => pages.get(`${scope}:${key}`)),
      writePage: vi.fn(
        async (
          scope: string,
          _scopeId: string | null,
          key: string,
          frontmatter: Record<string, unknown>,
          content: string,
        ) => {
        pages.set(`${scope}:${key}`, { pageKey: key, frontmatter, content });
        },
      ),
    };
    const configService = {
      listFiles: vi.fn(async () => ({
        files: ['global/accounts-at-risk.md', 'global/historic-sql/nested-legacy.md'],
      })),
    };
    const semanticLayerService = {
      loadAllSources: vi.fn(async () => [
        {
          name: 'mart_customer_health',
          grain: [],
          columns: [],
          joins: [],
          measures: [{ name: 'high_risk_account_count', expr: 'count(*)' }],
          segments: [{ name: 'high_risk', expr: "risk_level = 'high'" }],
        },
        {
          name: 'int_procurement_qualifying_actions',
          grain: [],
          columns: [],
          joins: [],
          measures: [],
        },
      ]),
    };

    const result = await repairWikiSlRefs({
      wikiService: wikiService as never,
      semanticLayerService: semanticLayerService as never,
      configService: configService as never,
      connectionIds: ['warehouse'],
    });

    expect(result.repairs).toEqual([
      {
        pageKey: 'accounts-at-risk',
        scope: 'GLOBAL',
        scopeId: null,
        removedRefs: ['mart_customer_health.medium_risk_account_count'],
      },
    ]);
    expect(wikiService.writePage).toHaveBeenCalledWith(
      'GLOBAL',
      null,
      'accounts-at-risk',
      expect.objectContaining({
        sl_refs: [
          'mart_customer_health',
          'mart_customer_health.high_risk_account_count',
          'mart_customer_health.high_risk',
          'int_procurement_qualifying_actions',
        ],
      }),
      'Risk context.',
      'System User',
      'system@example.com',
      'Repair semantic-layer refs: accounts-at-risk',
    );
  });
});
