import type { KtxLocalProject } from '../project/index.js';
import { describe, expect, it, vi } from 'vitest';
import {
  exportLocalRelationshipFeedbackLabels,
  formatKtxRelationshipFeedbackLabelsJsonl,
} from './relationship-feedback-export.js';
import type { KtxRelationshipReviewDecisionArtifact } from './relationship-review-decisions.js';

function projectWithFiles(files: Record<string, unknown>): KtxLocalProject {
  const contentByPath = new Map(
    Object.entries(files).map(([path, value]) => [
      path,
      typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    ]),
  );
  return {
    projectDir: '/tmp/ktx-project',
    fileStore: {
      async listFiles(path: string) {
        return {
          files: [...contentByPath.keys()].filter((file) => file.startsWith(`${path}/`)).sort(),
        };
      },
      async readFile(path: string) {
        const content = contentByPath.get(path);
        if (!content) {
          throw new Error(`missing file ${path}`);
        }
        return { content };
      },
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      getFileHistory: vi.fn(),
      forWorktree: vi.fn(),
    },
  } as unknown as KtxLocalProject;
}

function decisionsArtifact(input: {
  connectionId: string;
  runId: string;
  syncId: string;
  decisions: KtxRelationshipReviewDecisionArtifact['decisions'];
}): KtxRelationshipReviewDecisionArtifact {
  return {
    connectionId: input.connectionId,
    runId: input.runId,
    syncId: input.syncId,
    generatedAt: '2026-05-07T12:00:00.000Z',
    decisions: input.decisions,
  };
}

const acceptedOrderCustomer = {
  candidateId: 'orders:orders.customer_id->customers:customers.id',
  decision: 'accepted' as const,
  previousStatus: 'review' as const,
  connectionId: 'warehouse',
  runId: 'scan-run-a',
  syncId: 'sync-a',
  decidedAt: '2026-05-07T12:00:00.000Z',
  reviewer: 'Andrey',
  note: 'Confirmed in warehouse docs',
  from: {
    tableId: 'orders',
    columnIds: ['orders.customer_id'],
    table: { catalog: null, db: 'public', name: 'orders' },
    columns: ['customer_id'],
  },
  to: {
    tableId: 'customers',
    columnIds: ['customers.id'],
    table: { catalog: null, db: 'public', name: 'customers' },
    columns: ['id'],
  },
  relationshipType: 'many_to_one' as const,
  source: 'deterministic_name',
  score: 0.62,
  confidence: 0.62,
  pkScore: 0.91,
  fkScore: 0.62,
  reasons: ['fk_score_review'],
};

const rejectedOrderNote = {
  candidateId: 'orders:orders.note_id->notes:notes.id',
  decision: 'rejected' as const,
  previousStatus: 'rejected' as const,
  connectionId: 'warehouse',
  runId: 'scan-run-a',
  syncId: 'sync-a',
  decidedAt: '2026-05-07T12:05:00.000Z',
  reviewer: 'Andrey',
  note: null,
  from: {
    tableId: 'orders',
    columnIds: ['orders.note_id'],
    table: { catalog: null, db: 'public', name: 'orders' },
    columns: ['note_id'],
  },
  to: {
    tableId: 'notes',
    columnIds: ['notes.id'],
    table: { catalog: null, db: 'public', name: 'notes' },
    columns: ['id'],
  },
  relationshipType: 'many_to_one' as const,
  source: 'deterministic_name',
  score: 0.2,
  confidence: 0.2,
  pkScore: 0.4,
  fkScore: 0.2,
  reasons: ['low_source_coverage'],
};

const acceptedInvoiceAccount = {
  candidateId: 'invoices:invoices.account_id->accounts:accounts.id',
  decision: 'accepted' as const,
  previousStatus: 'accepted' as const,
  connectionId: 'billing',
  runId: 'scan-run-b',
  syncId: 'sync-b',
  decidedAt: '2026-05-07T12:10:00.000Z',
  reviewer: 'ktx',
  note: null,
  from: {
    tableId: 'invoices',
    columnIds: ['invoices.account_id'],
    table: { catalog: null, db: 'billing', name: 'invoices' },
    columns: ['account_id'],
  },
  to: {
    tableId: 'accounts',
    columnIds: ['accounts.id'],
    table: { catalog: null, db: 'billing', name: 'accounts' },
    columns: ['id'],
  },
  relationshipType: 'many_to_one' as const,
  source: 'formal_metadata',
  score: 1,
  confidence: 1,
  pkScore: 1,
  fkScore: 1,
  reasons: ['formal_metadata_relationship'],
};

describe('relationship feedback export', () => {
  it('exports stable labels from all relationship review decision artifacts', async () => {
    const project = projectWithFiles({
      'raw-sources/warehouse/live-database/sync-a/enrichment/relationship-review-decisions.json': decisionsArtifact({
        connectionId: 'warehouse',
        runId: 'scan-run-a',
        syncId: 'sync-a',
        decisions: [rejectedOrderNote, acceptedOrderCustomer],
      }),
      'raw-sources/billing/live-database/sync-b/enrichment/relationship-review-decisions.json': decisionsArtifact({
        connectionId: 'billing',
        runId: 'scan-run-b',
        syncId: 'sync-b',
        decisions: [acceptedInvoiceAccount],
      }),
      'raw-sources/warehouse/live-database/sync-a/enrichment/relationships.json': { accepted: [], review: [], rejected: [] },
    });

    const result = await exportLocalRelationshipFeedbackLabels(project, {
      now: () => new Date('2026-05-07T13:00:00.000Z'),
    });

    expect(result.summary).toEqual({
      total: 3,
      accepted: 2,
      rejected: 1,
      connections: 2,
      runs: 2,
    });
    expect(result.labels.map((label) => label.candidateId)).toEqual([
      'invoices:invoices.account_id->accounts:accounts.id',
      'orders:orders.customer_id->customers:customers.id',
      'orders:orders.note_id->notes:notes.id',
    ]);
    expect(result.labels[0]).toMatchObject({
      schemaVersion: 1,
      decision: 'accepted',
      connectionId: 'billing',
      source: 'formal_metadata',
      fromTable: 'billing.invoices',
      fromColumns: ['account_id'],
      toTable: 'billing.accounts',
      toColumns: ['id'],
      artifactPath: 'raw-sources/billing/live-database/sync-b/enrichment/relationship-review-decisions.json',
    });
    expect(result.warnings).toEqual([]);
  });

  it('filters labels by connection and decision', async () => {
    const project = projectWithFiles({
      'raw-sources/warehouse/live-database/sync-a/enrichment/relationship-review-decisions.json': decisionsArtifact({
        connectionId: 'warehouse',
        runId: 'scan-run-a',
        syncId: 'sync-a',
        decisions: [rejectedOrderNote, acceptedOrderCustomer],
      }),
      'raw-sources/billing/live-database/sync-b/enrichment/relationship-review-decisions.json': decisionsArtifact({
        connectionId: 'billing',
        runId: 'scan-run-b',
        syncId: 'sync-b',
        decisions: [acceptedInvoiceAccount],
      }),
    });

    const result = await exportLocalRelationshipFeedbackLabels(project, {
      connectionId: 'warehouse',
      decision: 'rejected',
      now: () => new Date('2026-05-07T13:00:00.000Z'),
    });

    expect(result.summary).toMatchObject({ total: 1, accepted: 0, rejected: 1 });
    expect(result.labels).toHaveLength(1);
    expect(result.labels[0]?.candidateId).toBe('orders:orders.note_id->notes:notes.id');
  });

  it('formats JSONL with one stable label object per line', async () => {
    const project = projectWithFiles({
      'raw-sources/warehouse/live-database/sync-a/enrichment/relationship-review-decisions.json': decisionsArtifact({
        connectionId: 'warehouse',
        runId: 'scan-run-a',
        syncId: 'sync-a',
        decisions: [acceptedOrderCustomer],
      }),
    });
    const result = await exportLocalRelationshipFeedbackLabels(project, {
      now: () => new Date('2026-05-07T13:00:00.000Z'),
    });

    const lines = formatKtxRelationshipFeedbackLabelsJsonl(result).trim().split('\n').map((line) => JSON.parse(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      schemaVersion: 1,
      candidateId: 'orders:orders.customer_id->customers:customers.id',
      decision: 'accepted',
      relationshipType: 'many_to_one',
    });
  });

  it('records parse warnings and continues exporting readable decision artifacts', async () => {
    const project = projectWithFiles({
      'raw-sources/warehouse/live-database/sync-a/enrichment/relationship-review-decisions.json': decisionsArtifact({
        connectionId: 'warehouse',
        runId: 'scan-run-a',
        syncId: 'sync-a',
        decisions: [acceptedOrderCustomer],
      }),
      'raw-sources/broken/live-database/sync-b/enrichment/relationship-review-decisions.json': '{not-json',
    });

    const result = await exportLocalRelationshipFeedbackLabels(project, {
      now: () => new Date('2026-05-07T13:00:00.000Z'),
    });

    expect(result.summary.total).toBe(1);
    expect(result.warnings).toEqual([
      {
        path: 'raw-sources/broken/live-database/sync-b/enrichment/relationship-review-decisions.json',
        message: expect.any(String),
      },
    ]);
    expect(result.warnings[0]?.message.length).toBeGreaterThan(0);
  });
});
