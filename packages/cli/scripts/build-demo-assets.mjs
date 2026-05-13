import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(packageRoot, '../..');
const defaultDemoSource = resolve(repoRoot, '../../../orbit-demo-source');
const sourceRoot = resolve(process.env.KTX_DEMO_SOURCE_DIR ?? defaultDemoSource);
const assetDir = join(packageRoot, 'assets/demo/orbit');
const dbPath = join(assetDir, 'demo.db');
const exampleDbtProjectDir = ['dbt', `${'kae'}lio_demo`].join('/');
const packagedDemoSource = 'packaged-orbit-demo';

const warehouseTables = [
  'accounts',
  'contracts',
  'users',
  'invoices',
  'arr_movements',
  'support_tickets',
  'purchase_requests',
  'plans',
];

const copyFiles = [
  [`${exampleDbtProjectDir}/dbt_project.yml`, 'raw-sources/dbt/dbt_project.yml'],
  [`${exampleDbtProjectDir}/models/sources.yml`, 'raw-sources/dbt/sources.yml'],
  [`${exampleDbtProjectDir}/models/schema.yml`, 'raw-sources/dbt/schema.yml'],
  [`${exampleDbtProjectDir}/models/marts/mart_revenue_daily.sql`, 'raw-sources/dbt/models/marts/mart_revenue_daily.sql'],
  [`${exampleDbtProjectDir}/models/marts/mart_arr_daily.sql`, 'raw-sources/dbt/models/marts/mart_arr_daily.sql'],
  [
    `${exampleDbtProjectDir}/models/marts/mart_customer_health.sql`,
    'raw-sources/dbt/models/marts/mart_customer_health.sql',
  ],
  ['views/account_retention.view.lkml', 'raw-sources/bi/account_retention.view.lkml'],
  ['views/arr_daily.view.lkml', 'raw-sources/bi/arr_daily.view.lkml'],
  ['views/customer_health.view.lkml', 'raw-sources/bi/customer_health.view.lkml'],
  ['views/procurement_activity.view.lkml', 'raw-sources/bi/procurement_activity.view.lkml'],
  ['views/revenue_daily.view.lkml', 'raw-sources/bi/revenue_daily.view.lkml'],
  ['dashboards/revenue_exec.dashboard.lookml', 'raw-sources/bi/revenue_exec.dashboard.lookml'],
  ['dashboards/retention_exec_q1.dashboard.lookml', 'raw-sources/bi/retention_exec_q1.dashboard.lookml'],
  ['notion/export/pages/revenue-reporting-policy.md', 'raw-sources/notion/revenue-reporting-policy.md'],
  ['notion/export/pages/sales-ops-segmentation-guide.md', 'raw-sources/notion/sales-ops-segmentation-guide.md'],
  ['notion/export/pages/customer-health-playbook.md', 'raw-sources/notion/customer-health-playbook.md'],
  ['notion/export/pages/support-escalation-runbook.md', 'raw-sources/notion/support-escalation-runbook.md'],
  [
    'notion/export/pages/arr-and-contract-reporting-notes.md',
    'raw-sources/notion/arr-and-contract-reporting-notes.md',
  ],
  [
    'notion/export/pages/activation-policy-decision-record.md',
    'raw-sources/notion/activation-policy-decision-record.md',
  ],
  [
    'notion/export/pages/retention-and-nrr-definition-notes.md',
    'raw-sources/notion/retention-and-nrr-definition-notes.md',
  ],
  ['notion/export/pages/analyst-onboarding.md', 'raw-sources/notion/analyst-onboarding.md'],
];

const semanticLayerTables = [
  'accounts',
  'contracts',
  'invoices',
  'arr_movements',
  'purchase_requests',
  'support_tickets',
];

const semanticLayerDescriptions = {
  accounts: 'Customer accounts with industry, region, lifecycle, and internal/test flags.',
  contracts: 'Subscription contracts with ARR, plan, renewal, and status details.',
  invoices: 'Billing invoices with payment status and revenue-recognition dates.',
  arr_movements: 'ARR movement ledger for expansion, contraction, churn, and reactivation analysis.',
  purchase_requests: 'Procurement workflow requests with requester, status, supplier, and spend fields.',
  support_tickets: 'Customer support tickets with severity, category, status, and resolution tracking.',
};

const semanticLayerMeasures = {
  accounts: [
    { name: 'account_count', expr: 'count(distinct account_id)' },
    { name: 'enterprise_count', expr: 'count(distinct account_id)', filter: "size_band = 'enterprise'" },
  ],
  contracts: [
    { name: 'contract_count', expr: 'count(distinct contract_id)' },
    { name: 'total_arr', expr: 'sum(contract_arr_cents) / 100.0', filter: "status = 'active'" },
  ],
  invoices: [
    { name: 'invoice_count', expr: 'count(*)' },
    { name: 'paid_invoice_count', expr: 'count(*)', filter: "status = 'paid'" },
  ],
  arr_movements: [
    { name: 'movement_count', expr: 'count(*)' },
    { name: 'net_arr_delta', expr: 'sum(arr_delta_cents) / 100.0' },
  ],
  purchase_requests: [
    { name: 'request_count', expr: 'count(*)' },
    { name: 'approved_spend', expr: 'sum(amount_cents) / 100.0', filter: "status = 'approved'" },
  ],
  support_tickets: [
    { name: 'ticket_count', expr: 'count(*)' },
    { name: 'open_ticket_count', expr: 'count(*)', filter: "status != 'resolved'" },
  ],
};

const knowledgePages = [
  {
    file: 'arr-contract-first.md',
    summary: 'ARR uses contract-first precedence before subscription-derived revenue.',
    tags: ['finance', 'arr', 'revenue'],
    refs: [],
    slRefs: ['orbit_demo.contracts', 'orbit_demo.arr_movements'],
    body: [
      'ARR is calculated from active recurring contract ARR before falling back to subscription-derived revenue.',
      'Do not double-count subscription MRR when an active contract row covers the same account and period.',
      'Exclude cancelled contracts ending before the metric date, future-starting contracts, internal accounts, and test accounts.',
    ],
  },
  {
    file: 'revenue-gross-to-net.md',
    summary: 'Gross-to-net revenue reconciles paid invoices, credits, and refunds.',
    tags: ['finance', 'revenue'],
    refs: ['arr-contract-first'],
    slRefs: ['orbit_demo.invoices'],
    body: [
      'Gross revenue starts from paid invoice activity. Net revenue subtracts credits and successful refunds in the month they are recorded.',
      'Exclude unpaid, void, draft, failed, internal, and test-account invoice activity from canonical revenue reporting.',
      'February 2026 has an elevated refund event captured in the source notes and revenue dashboard.',
    ],
  },
  {
    file: 'discount-expiration.md',
    summary: 'Discount expirations are tracked separately from organic contraction.',
    tags: ['finance', 'retention'],
    refs: ['arr-contract-first', 'nrr-retention'],
    slRefs: ['orbit_demo.contracts', 'orbit_demo.arr_movements'],
    body: [
      'Discount expiration events identify pricing changes when negotiated discounts end.',
      'Track these separately from organic contraction so board reporting can split pricing-driven and usage-driven changes.',
      'Use movement_reason on arr_movements when separating discount expiration from churn or seat-reduction events.',
    ],
  },
  {
    file: 'nrr-retention.md',
    summary: 'NRR is calculated at parent-account grain by calendar quarter.',
    tags: ['analytics', 'retention', 'nrr'],
    refs: ['arr-contract-first'],
    slRefs: ['orbit_demo.arr_movements', 'orbit_demo.accounts'],
    body: [
      'Net Revenue Retention uses parent-account rollups by calendar quarter.',
      'The formula is starting ARR plus expansion minus contraction and churn, divided by starting ARR.',
      'Exclude parent accounts with zero starting ARR, new business, reactivations, and internal/test accounts from the denominator.',
    ],
  },
  {
    file: 'segment-classification.md',
    summary: 'Account segments derive from plan normalization and effective-dated mapping.',
    tags: ['sales-ops', 'segmentation'],
    refs: [],
    slRefs: ['orbit_demo.accounts', 'orbit_demo.contracts'],
    body: [
      'Account segment labels combine plan_code, canonical_plan_code, and size_band fields.',
      'Historical plan code pro_plus maps to growth for current segment analysis.',
      'Use the mapping active at the metric date when segment definitions change over time.',
    ],
  },
  {
    file: 'activation-policy.md',
    summary: 'Account activation policy changed on January 15, 2026.',
    tags: ['growth', 'activation', 'policy'],
    refs: [],
    slRefs: ['orbit_demo.accounts', 'orbit_demo.purchase_requests'],
    body: [
      'Before January 15, 2026, activation meant first requester login.',
      'On and after January 15, 2026, activation requires an approved purchase request and at least three activated requesters.',
      'Always separate pre-policy and post-policy cohorts when comparing activation rates.',
    ],
  },
  {
    file: 'procurement-workflows.md',
    summary: 'Procurement workflow activity measures active requesters and qualifying actions.',
    tags: ['product', 'procurement'],
    refs: ['activation-policy'],
    slRefs: ['orbit_demo.purchase_requests'],
    body: [
      'Weekly active requesters counts distinct non-internal requesters with a qualifying procurement action in the calendar week.',
      'Qualifying actions include purchase request creation, approval decisions, supplier invites, and purchase-order creation.',
      'Purchase-request comments and short sessions are excluded from the canonical requester activity metric.',
    ],
  },
  {
    file: 'customer-health-scoring.md',
    summary: 'Customer health combines support severity and procurement activity.',
    tags: ['customer-success', 'health', 'churn-risk'],
    refs: ['nrr-retention'],
    slRefs: ['orbit_demo.support_tickets', 'orbit_demo.purchase_requests', 'orbit_demo.accounts'],
    body: [
      'High-risk accounts have multiple recent high-severity tickets or no recent procurement activity on growth and enterprise plans.',
      'Medium risk captures partial support pressure or a material month-over-month decline in procurement activity.',
      'Internal and test accounts are excluded from customer health scoring.',
    ],
  },
  {
    file: 'support-escalation.md',
    summary: 'Support escalation tiers map ticket severity to SLA targets.',
    tags: ['support', 'sla'],
    refs: ['customer-health-scoring'],
    slRefs: ['orbit_demo.support_tickets'],
    body: [
      'Critical support tickets require immediate response and on-call escalation.',
      'High severity tickets should receive first response within four business hours.',
      'Resolution time is measured from created_at to resolved_at and only applies to resolved tickets.',
    ],
  },
  {
    file: 'internal-test-exclusion.md',
    summary: 'Canonical metrics exclude internal and test accounts and users.',
    tags: ['data-quality', 'governance'],
    refs: [],
    slRefs: ['orbit_demo.accounts'],
    body: [
      'All canonical customer metrics exclude rows marked as internal or test fixtures.',
      'This exclusion applies at both account and user grain when joining procurement, support, and revenue activity.',
      'If a metric unexpectedly increases, check whether new internal or test accounts were created without proper flags.',
    ],
  },
];

const provenanceLinks = [
  ['wiki', 'wiki/global/arr-contract-first.md', 'warehouse', 'contracts', 'describes', 1],
  [
    'wiki',
    'wiki/global/arr-contract-first.md',
    'notion',
    'raw-sources/notion/arr-and-contract-reporting-notes.md',
    'derived_from',
    0.95,
  ],
  ['wiki', 'wiki/global/revenue-gross-to-net.md', 'warehouse', 'invoices', 'describes', 1],
  [
    'wiki',
    'wiki/global/revenue-gross-to-net.md',
    'notion',
    'raw-sources/notion/revenue-reporting-policy.md',
    'derived_from',
    0.95,
  ],
  ['wiki', 'wiki/global/discount-expiration.md', 'warehouse', 'arr_movements', 'describes', 1],
  ['wiki', 'wiki/global/nrr-retention.md', 'warehouse', 'arr_movements', 'describes', 1],
  [
    'wiki',
    'wiki/global/nrr-retention.md',
    'notion',
    'raw-sources/notion/retention-and-nrr-definition-notes.md',
    'derived_from',
    0.95,
  ],
  ['wiki', 'wiki/global/nrr-retention.md', 'bi', 'raw-sources/bi/account_retention.view.lkml', 'derived_from', 0.85],
  ['wiki', 'wiki/global/segment-classification.md', 'warehouse', 'plans', 'describes', 1],
  [
    'wiki',
    'wiki/global/segment-classification.md',
    'notion',
    'raw-sources/notion/sales-ops-segmentation-guide.md',
    'derived_from',
    0.9,
  ],
  [
    'wiki',
    'wiki/global/activation-policy.md',
    'notion',
    'raw-sources/notion/activation-policy-decision-record.md',
    'derived_from',
    0.95,
  ],
  ['wiki', 'wiki/global/procurement-workflows.md', 'warehouse', 'purchase_requests', 'describes', 1],
  [
    'wiki',
    'wiki/global/customer-health-scoring.md',
    'notion',
    'raw-sources/notion/customer-health-playbook.md',
    'derived_from',
    0.9,
  ],
  ['wiki', 'wiki/global/customer-health-scoring.md', 'warehouse', 'support_tickets', 'describes', 1],
  [
    'wiki',
    'wiki/global/support-escalation.md',
    'notion',
    'raw-sources/notion/support-escalation-runbook.md',
    'derived_from',
    0.9,
  ],
  [
    'wiki',
    'wiki/global/internal-test-exclusion.md',
    'notion',
    'raw-sources/notion/analyst-onboarding.md',
    'derived_from',
    0.9,
  ],
  ['sl', 'orbit_demo.accounts', 'warehouse', 'accounts', 'models', 1],
  ['sl', 'orbit_demo.accounts', 'dbt', 'raw-sources/dbt/schema.yml', 'inherits_from', 0.95],
  ['sl', 'orbit_demo.contracts', 'warehouse', 'contracts', 'models', 1],
  ['sl', 'orbit_demo.invoices', 'warehouse', 'invoices', 'models', 1],
  ['sl', 'orbit_demo.arr_movements', 'warehouse', 'arr_movements', 'models', 1],
  ['sl', 'orbit_demo.purchase_requests', 'warehouse', 'purchase_requests', 'models', 1],
  ['sl', 'orbit_demo.support_tickets', 'warehouse', 'support_tickets', 'models', 1],
].map(([artifactKind, artifactKey, sourceKind, sourcePath, relationship, confidence], index) => ({
  id: `link-${String(index + 1).padStart(3, '0')}`,
  artifactKind,
  artifactKey,
  sourceKind,
  sourcePath,
  relationship,
  confidence,
}));

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertReadable(path, label) {
  if (!(await pathExists(path))) {
    throw new Error(
      `${label} not found at ${path}. Set KTX_DEMO_SOURCE_DIR to the Orbit demo source directory.`,
    );
  }
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function parseCsv(raw) {
  const lines = raw.trimEnd().split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => parseCsvLine(line));
  return { headers, rows };
}

function quoteIdentifier(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

function inferColumnType(column) {
  if (column.startsWith('is_')) {
    return 'boolean';
  }
  if (column.endsWith('_at') || column.endsWith('_date') || column === 'retired_at') {
    return 'time';
  }
  if (column.endsWith('_cents') || column.endsWith('_count')) {
    return 'number';
  }
  return 'string';
}

function renderKnowledgePage(page) {
  const refs = page.refs.length > 0 ? ['refs:', ...page.refs.map((ref) => `  - ${ref}`)] : ['refs: []'];
  const slRefs = page.slRefs.map((ref) => `  - ${ref}`).join('\n');
  return [
    '---',
    `summary: ${page.summary}`,
    'tags:',
    ...page.tags.map((tag) => `  - ${tag}`),
    ...refs,
    'sl_refs:',
    slRefs,
    'usage_mode: auto',
    '---',
    '',
    page.body.join('\n\n'),
    '',
  ].join('\n');
}

function renderMeasure(measure) {
  const lines = [`  - name: ${measure.name}`, `    expr: ${JSON.stringify(measure.expr)}`];
  if (measure.filter) {
    lines.push(`    filter: ${JSON.stringify(measure.filter)}`);
  }
  return lines.join('\n');
}

async function renderSemanticLayerSource(table) {
  const raw = await readFile(join(sourceRoot, 'database/seeds', `${table}.csv`), 'utf-8');
  const { headers } = parseCsv(raw);
  const primaryKey = headers[0];
  const joins =
    table === 'accounts'
      ? [
          '  - to: contracts',
          '    "on": "account_id = contracts.account_id"',
          '    relationship: one_to_many',
          '  - to: purchase_requests',
          '    "on": "account_id = purchase_requests.account_id"',
          '    relationship: one_to_many',
        ]
      : ['  - to: accounts', '    "on": "account_id = accounts.account_id"', '    relationship: many_to_one'];

  return [
    `name: ${table}`,
    `table: ${table}`,
    `description: ${semanticLayerDescriptions[table]}`,
    'grain:',
    `  - ${primaryKey}`,
    'columns:',
    ...headers.flatMap((header) => [`  - name: ${header}`, `    type: ${inferColumnType(header)}`]),
    'joins:',
    ...joins,
    'measures:',
    ...semanticLayerMeasures[table].map(renderMeasure),
    'segments:',
    '  - name: external_only',
    '    expr: "coalesce(is_internal, 0) = 0 AND coalesce(is_test, 0) = 0"',
    '',
  ].join('\n');
}

async function writeWarehouse(db, rowCounts) {
  for (const table of warehouseTables) {
    const sourceCsv = join(sourceRoot, 'database/seeds', `${table}.csv`);
    const raw = await readFile(sourceCsv, 'utf-8');
    const { headers, rows } = parseCsv(raw);
    const columnsSql = headers.map((header) => `${quoteIdentifier(header)} TEXT`).join(', ');
    db.exec(`CREATE TABLE ${quoteIdentifier(table)} (${columnsSql});`);
    const placeholders = headers.map(() => '?').join(', ');
    const statement = db.prepare(`INSERT INTO ${quoteIdentifier(table)} VALUES (${placeholders})`);
    const insertAll = db.transaction((records) => {
      for (const record of records) {
        statement.run(record);
      }
    });
    insertAll(rows);
    rowCounts[table] = rows.length;
    await copyFile(sourceCsv, join(assetDir, 'raw-sources/warehouse', `${table}.csv`));
  }
}

async function copyCuratedSourceFiles() {
  for (const [from, to] of copyFiles) {
    const destination = join(assetDir, to);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(sourceRoot, from), destination);
  }
}

async function writeJson(relativePath, value) {
  const destination = join(assetDir, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeText(relativePath, value) {
  const destination = join(assetDir, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, value, 'utf-8');
}

function buildActions() {
  return [
    {
      unitKey: 'revenue-and-contracts',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/arr-contract-first.md',
      summary: 'ARR follows contract precedence with cancellation and discount caveats.',
      rawFiles: ['contracts', 'arr_movements', 'raw-sources/notion/arr-and-contract-reporting-notes.md'],
      status: 'success',
    },
    {
      unitKey: 'revenue-and-contracts',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/revenue-gross-to-net.md',
      summary: 'Invoice, refund, and revenue dashboard evidence reconcile gross to net revenue.',
      rawFiles: ['invoices', 'raw-sources/bi/revenue_exec.dashboard.lookml'],
      status: 'success',
    },
    {
      unitKey: 'revenue-and-contracts',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/discount-expiration.md',
      summary: 'Discount expiration is separated from organic contraction for retention reporting.',
      rawFiles: ['contracts', 'arr_movements'],
      status: 'success',
    },
    {
      unitKey: 'revenue-and-contracts',
      target: 'sl',
      action: 'created',
      key: 'orbit_demo.contracts',
      summary: 'Contract grain with active ARR measures and account joins.',
      rawFiles: ['contracts', 'raw-sources/dbt/schema.yml'],
      status: 'success',
    },
    {
      unitKey: 'revenue-and-contracts',
      target: 'sl',
      action: 'created',
      key: 'orbit_demo.invoices',
      summary: 'Invoice status measures tied to gross and net revenue reporting.',
      rawFiles: ['invoices', 'raw-sources/bi/revenue_daily.view.lkml'],
      status: 'success',
    },
    {
      unitKey: 'revenue-and-contracts',
      target: 'sl',
      action: 'created',
      key: 'orbit_demo.arr_movements',
      summary: 'ARR movement ledger for expansion, contraction, churn, and NRR.',
      rawFiles: ['arr_movements', 'raw-sources/bi/account_retention.view.lkml'],
      status: 'success',
    },
    {
      unitKey: 'retention-and-segments',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/nrr-retention.md',
      summary: 'NRR uses parent-account rollups and quarterly ARR movement windows.',
      rawFiles: ['accounts', 'arr_movements', 'raw-sources/notion/retention-and-nrr-definition-notes.md'],
      status: 'success',
    },
    {
      unitKey: 'retention-and-segments',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/segment-classification.md',
      summary: 'Segment labels come from plan mapping and sales-ops policy notes.',
      rawFiles: ['accounts', 'plans', 'raw-sources/notion/sales-ops-segmentation-guide.md'],
      status: 'success',
    },
    {
      unitKey: 'retention-and-segments',
      target: 'sl',
      action: 'created',
      key: 'orbit_demo.accounts',
      summary: 'Account dimensions with lifecycle, segment, and internal-test exclusions.',
      rawFiles: ['accounts', 'plans'],
      status: 'success',
    },
    {
      unitKey: 'procurement-and-activation',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/activation-policy.md',
      summary: 'Activation policy changed on January 15, 2026 and is encoded for agents.',
      rawFiles: ['purchase_requests', 'users', 'raw-sources/notion/activation-policy-decision-record.md'],
      status: 'success',
    },
    {
      unitKey: 'procurement-and-activation',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/procurement-workflows.md',
      summary: 'Procurement requester activity and approval events explain product usage.',
      rawFiles: ['purchase_requests', 'raw-sources/bi/procurement_activity.view.lkml'],
      status: 'success',
    },
    {
      unitKey: 'procurement-and-activation',
      target: 'sl',
      action: 'created',
      key: 'orbit_demo.purchase_requests',
      summary: 'Procurement request facts with requester and approval-state measures.',
      rawFiles: ['purchase_requests'],
      status: 'success',
    },
    {
      unitKey: 'support-and-health',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/customer-health-scoring.md',
      summary: 'Customer health combines support severity, ARR exposure, and product usage.',
      rawFiles: ['support_tickets', 'raw-sources/notion/customer-health-playbook.md'],
      status: 'success',
    },
    {
      unitKey: 'support-and-health',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/support-escalation.md',
      summary: 'Escalation tiers map ticket severity to SLA expectations.',
      rawFiles: ['support_tickets', 'raw-sources/notion/support-escalation-runbook.md'],
      status: 'success',
    },
    {
      unitKey: 'support-and-health',
      target: 'sl',
      action: 'created',
      key: 'orbit_demo.support_tickets',
      summary: 'Support ticket facts with severity, status, and resolution-hour measures.',
      rawFiles: ['support_tickets'],
      status: 'success',
    },
    {
      unitKey: 'governance-and-exclusions',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/internal-test-exclusion.md',
      summary: 'Canonical metrics exclude internal and test accounts across source families.',
      rawFiles: ['raw-sources/notion/analyst-onboarding.md'],
      status: 'success',
    },
  ];
}

function buildReplay(provenance, transcripts) {
  return {
    memoryFlowReplaySchemaVersion: 1,
    replay: {
      runId: 'demo-seeded-orbit',
      connectionId: 'orbit_demo',
      adapter: 'live-database',
      status: 'done',
      sourceDir: null,
      syncId: 'demo-seeded-sync',
      reportId: 'demo-seeded-report',
      reportPath: 'reports/seeded-demo-report.json',
      errors: [],
      metadata: {
        schemaVersion: 1,
        mode: 'seeded',
        origin: 'packaged',
        timing: 'prebuilt',
        capturedAt: '2026-05-06T00:00:00.000Z',
        sourceReportId: 'demo-seeded-report',
        sourceReportPath: 'reports/seeded-demo-report.json',
        fallbackReason: null,
      },
      events: [
        { type: 'source_acquired', adapter: 'live-database', trigger: 'demo_seeded', fileCount: 8 },
        { type: 'source_acquired', adapter: 'dbt_descriptions', trigger: 'demo_seeded', fileCount: 6 },
        { type: 'source_acquired', adapter: 'looker', trigger: 'demo_seeded', fileCount: 7 },
        { type: 'source_acquired', adapter: 'notion', trigger: 'demo_seeded', fileCount: 8 },
        { type: 'scope_detected', fingerprint: 'sqlite:orbit-demo' },
        { type: 'raw_snapshot_written', syncId: 'demo-seeded-sync', rawFileCount: 29 },
        { type: 'diff_computed', added: 29, modified: 0, deleted: 0, unchanged: 0 },
        { type: 'chunks_planned', chunkCount: 5, workUnitCount: 5, evictionCount: 0 },
        { type: 'work_unit_started', unitKey: 'revenue-and-contracts', skills: ['wiki_capture', 'sl_capture'], stepBudget: 40 },
        {
          type: 'candidate_action',
          unitKey: 'revenue-and-contracts',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/arr-contract-first.md',
        },
        {
          type: 'candidate_action',
          unitKey: 'revenue-and-contracts',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/revenue-gross-to-net.md',
        },
        {
          type: 'candidate_action',
          unitKey: 'revenue-and-contracts',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/discount-expiration.md',
        },
        {
          type: 'candidate_action',
          unitKey: 'revenue-and-contracts',
          target: 'sl',
          action: 'created',
          key: 'orbit_demo.contracts',
        },
        {
          type: 'candidate_action',
          unitKey: 'revenue-and-contracts',
          target: 'sl',
          action: 'created',
          key: 'orbit_demo.invoices',
        },
        {
          type: 'candidate_action',
          unitKey: 'revenue-and-contracts',
          target: 'sl',
          action: 'created',
          key: 'orbit_demo.arr_movements',
        },
        { type: 'work_unit_finished', unitKey: 'revenue-and-contracts', status: 'success' },
        { type: 'work_unit_started', unitKey: 'retention-and-segments', skills: ['wiki_capture', 'sl_capture'], stepBudget: 40 },
        {
          type: 'candidate_action',
          unitKey: 'retention-and-segments',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/nrr-retention.md',
        },
        {
          type: 'candidate_action',
          unitKey: 'retention-and-segments',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/segment-classification.md',
        },
        {
          type: 'candidate_action',
          unitKey: 'retention-and-segments',
          target: 'sl',
          action: 'created',
          key: 'orbit_demo.accounts',
        },
        { type: 'work_unit_finished', unitKey: 'retention-and-segments', status: 'success' },
        {
          type: 'work_unit_started',
          unitKey: 'procurement-and-activation',
          skills: ['wiki_capture', 'sl_capture'],
          stepBudget: 40,
        },
        {
          type: 'candidate_action',
          unitKey: 'procurement-and-activation',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/activation-policy.md',
        },
        {
          type: 'candidate_action',
          unitKey: 'procurement-and-activation',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/procurement-workflows.md',
        },
        {
          type: 'candidate_action',
          unitKey: 'procurement-and-activation',
          target: 'sl',
          action: 'created',
          key: 'orbit_demo.purchase_requests',
        },
        { type: 'work_unit_finished', unitKey: 'procurement-and-activation', status: 'success' },
        { type: 'work_unit_started', unitKey: 'support-and-health', skills: ['wiki_capture', 'sl_capture'], stepBudget: 40 },
        {
          type: 'candidate_action',
          unitKey: 'support-and-health',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/customer-health-scoring.md',
        },
        {
          type: 'candidate_action',
          unitKey: 'support-and-health',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/support-escalation.md',
        },
        {
          type: 'candidate_action',
          unitKey: 'support-and-health',
          target: 'sl',
          action: 'created',
          key: 'orbit_demo.support_tickets',
        },
        { type: 'work_unit_finished', unitKey: 'support-and-health', status: 'success' },
        { type: 'work_unit_started', unitKey: 'governance-and-exclusions', skills: ['wiki_capture'], stepBudget: 40 },
        {
          type: 'candidate_action',
          unitKey: 'governance-and-exclusions',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/internal-test-exclusion.md',
        },
        { type: 'work_unit_finished', unitKey: 'governance-and-exclusions', status: 'success' },
        { type: 'reconciliation_finished', conflictCount: 0, fallbackCount: 0 },
        { type: 'saved', commitSha: 'demo-seeded', wikiCount: 10, slCount: 6 },
        { type: 'provenance_recorded', rowCount: provenance.length },
        { type: 'report_created', runId: 'demo-seeded-orbit', reportPath: 'reports/seeded-demo-report.json' },
      ],
      plannedWorkUnits: [
        {
          unitKey: 'revenue-and-contracts',
          rawFiles: ['contracts', 'invoices', 'arr_movements'],
          peerFileCount: 3,
          dependencyCount: 3,
        },
        {
          unitKey: 'retention-and-segments',
          rawFiles: ['accounts', 'plans'],
          peerFileCount: 2,
          dependencyCount: 2,
        },
        {
          unitKey: 'procurement-and-activation',
          rawFiles: ['purchase_requests', 'users'],
          peerFileCount: 2,
          dependencyCount: 2,
        },
        { unitKey: 'support-and-health', rawFiles: ['support_tickets'], peerFileCount: 1, dependencyCount: 1 },
        {
          unitKey: 'governance-and-exclusions',
          rawFiles: ['notion/export/pages/analyst-onboarding.md'],
          peerFileCount: 1,
          dependencyCount: 0,
        },
      ],
      details: {
        actions: buildActions(),
        provenance,
        transcripts,
      },
    },
  };
}

async function writeGeneratedContext(rowCounts) {
  for (const page of knowledgePages) {
    await writeText(join('wiki/global', page.file), renderKnowledgePage(page));
  }

  for (const table of semanticLayerTables) {
    await writeText(join('semantic-layer/orbit_demo', `${table}.yaml`), await renderSemanticLayerSource(table));
  }

  const provenance = provenanceLinks.map((link) => ({
    rawPath: link.sourcePath,
    artifactKind: link.artifactKind,
    artifactKey: link.artifactKey,
    actionType: link.artifactKind === 'sl' ? 'sl_written' : 'wiki_written',
  }));
  const transcripts = [
    'revenue-and-contracts',
    'retention-and-segments',
    'procurement-and-activation',
    'support-and-health',
    'governance-and-exclusions',
  ].map((unitKey) => ({
    unitKey,
    path: `transcripts/${unitKey}.jsonl`,
    toolCallCount: unitKey === 'governance-and-exclusions' ? 2 : 5,
    errorCount: 0,
    toolNames: unitKey === 'governance-and-exclusions' ? ['wiki_write'] : ['wiki_write', 'sl_write_source'],
  }));

  await writeJson('links/provenance.json', provenanceLinks);
  await writeJson('reports/seeded-demo-report.json', {
    id: 'demo-seeded-report',
    runId: 'demo-seeded-orbit',
    connectionId: 'orbit_demo',
    mode: 'seeded',
    status: 'complete',
    createdAt: '2026-05-06T00:00:00.000Z',
    summary: {
      sources: {
        warehouse: { tables: 8, rows: Object.values(rowCounts).reduce((sum, count) => sum + count, 0) },
        dbt: { models: 3, sources: 8 },
        bi: { explores: 5, dashboards: 2, views: 5 },
        notion: { pages: 8 },
      },
      generated: {
        semanticLayerSources: 6,
        knowledgePages: 10,
        provenanceLinks: provenanceLinks.length,
      },
      metadata: {
        mode: 'seeded',
        origin: 'packaged',
        llmCalls: 0,
        timing: 'prebuilt',
        source: packagedDemoSource,
      },
    },
  });
  await writeJson('manifest.json', {
    demoAssetSchemaVersion: 2,
    name: 'orbit',
    displayName: 'Orbit Demo',
    mode: 'seeded',
    sqliteDatabase: 'demo.db',
    replay: 'replay.memory-flow.v1.json',
    report: 'reports/seeded-demo-report.json',
    source: packagedDemoSource,
    sources: {
      warehouse: { label: 'Warehouse', path: 'demo.db', tables: 8, rowCounts },
      dbt: { label: 'dbt', path: 'raw-sources/dbt', models: 3, sourceTables: 8 },
      bi: { label: 'BI', path: 'raw-sources/bi', explores: 5, dashboards: 2 },
      notion: { label: 'Notion', path: 'raw-sources/notion', pages: 8 },
    },
    generated: {
      semanticLayer: { path: 'semantic-layer/orbit_demo', sourceCount: 6 },
      knowledge: { path: 'wiki/global', pageCount: 10 },
      links: { path: 'links', linkCount: provenanceLinks.length },
    },
  });
  await writeJson('replay.memory-flow.v1.json', buildReplay(provenance, transcripts));
}

await assertReadable(join(sourceRoot, 'database/seeds/accounts.csv'), `${packagedDemoSource} seed data`);
await assertReadable(join(sourceRoot, `${exampleDbtProjectDir}/models/schema.yml`), `${packagedDemoSource} dbt schema`);
await assertReadable(join(sourceRoot, 'views/revenue_daily.view.lkml'), `${packagedDemoSource} LookML views`);
await assertReadable(
  join(sourceRoot, 'notion/export/pages/revenue-reporting-policy.md'),
  `${packagedDemoSource} Notion export`,
);

await rm(assetDir, { recursive: true, force: true });
for (const relativeDir of [
  'raw-sources/warehouse',
  'raw-sources/dbt/models/marts',
  'raw-sources/bi',
  'raw-sources/notion',
  'semantic-layer/orbit_demo',
  'wiki/global',
  'links',
  'reports',
]) {
  await mkdir(join(assetDir, relativeDir), { recursive: true });
}

const rowCounts = {};
await rm(dbPath, { force: true });
const db = new Database(dbPath);
try {
  await writeWarehouse(db, rowCounts);
} finally {
  db.close();
}
await copyCuratedSourceFiles();
await writeGeneratedContext(rowCounts);

const dbStat = await stat(dbPath);
if (dbStat.size >= 10 * 1024 * 1024) {
  throw new Error(`Seeded demo SQLite bundle is too large: ${dbStat.size} bytes`);
}
