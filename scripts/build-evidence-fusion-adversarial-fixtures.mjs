#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildBenchmarkSnapshot, writeFixtureFiles } from './build-benchmark-snapshot.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ktxRoot = path.resolve(scriptDir, '..');
const fixtureRoot = path.join(ktxRoot, 'packages', 'context', 'test', 'fixtures', 'relationship-benchmarks');
const require = createRequire(new URL('../packages/context/package.json', import.meta.url));
const Database = require('better-sqlite3');
const { stringify: yamlStringify } = require('yaml');

function q(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlValue(value) {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insertSql(table, columns, rows) {
  return `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES\n${rows
    .map((row) => `  (${row.map(sqlValue).join(', ')})`)
    .join(',\n')};`;
}

function fixtureYaml(config) {
  return yamlStringify({
    id: config.id,
    name: config.name,
    tier: config.tier,
    origin: 'synthetic',
    thresholdEligible: false,
    ...(config.validationBudget === undefined ? {} : { validationBudget: config.validationBudget }),
    defaultModes: ['declared_pks_and_declared_fks_removed'],
  });
}

function writeFixture(config) {
  const fixtureDir = path.join(fixtureRoot, config.id);
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(path.join(fixtureDir, 'fixture.yaml'), fixtureYaml(config), 'utf8');

  const dataPath = path.join(fixtureDir, 'data.sqlite');
  const db = new Database(dataPath);
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(config.sql);
    const { snapshot } = buildBenchmarkSnapshot({ db, fixtureId: config.id });
    writeFixtureFiles({ fixtureDir, snapshot, expected: config.expected });
  } finally {
    db.close();
  }

  if (config.compressArtifacts) {
    for (const fileName of ['snapshot.json', 'data.sqlite']) {
      const rawPath = path.join(fixtureDir, fileName);
      writeFileSync(`${rawPath}.gz`, gzipSync(readFileSync(rawPath)), 'utf8');
      unlinkSync(rawPath);
    }
  }

  console.log(`[built] ${config.id}: ${config.expected.expectedPks.length} PKs, ${config.expected.expectedLinks.length} links`);
}

function nonEnglishFixture() {
  return {
    id: 'non_english_naming_no_declared_constraints',
    name: 'Non-English naming fixture with no declared constraints',
    tier: 'row_bearing',
    sql: [
      'CREATE TABLE kundenstamm (kundennummer TEXT NOT NULL, firmenname TEXT NOT NULL, stadt TEXT NOT NULL);',
      insertSql('kundenstamm', ['kundennummer', 'firmenname', 'stadt'], [
        ['K-001', 'Baeckerei Mueller', 'Muenchen'],
        ['K-002', 'Cafe Sakura', 'Berlin'],
        ['K-003', 'Nord Handel', 'Hamburg'],
      ]),
      'CREATE TABLE bestellungen (bestellnummer TEXT NOT NULL, "kaeufer_nummer" TEXT NOT NULL, betrag INTEGER NOT NULL);',
      insertSql('bestellungen', ['bestellnummer', 'kaeufer_nummer', 'betrag'], [
        ['B-100', 'K-001', 420],
        ['B-101', 'K-002', 300],
        ['B-102', 'K-001', 125],
      ]),
      'CREATE TABLE seihin (seihin_bango TEXT NOT NULL, bezeichnung TEXT NOT NULL, kategorie TEXT NOT NULL);',
      insertSql('seihin', ['seihin_bango', 'bezeichnung', 'kategorie'], [
        ['S-01', 'ocha', 'drink'],
        ['S-02', 'pan', 'food'],
        ['S-03', 'miso', 'food'],
      ]),
      'CREATE TABLE uriage (verkauf_nr TEXT NOT NULL, hinban TEXT NOT NULL, menge INTEGER NOT NULL);',
      insertSql('uriage', ['verkauf_nr', 'hinban', 'menge'], [
        ['U-1', 'S-01', 7],
        ['U-2', 'S-02', 3],
        ['U-3', 'S-01', 5],
      ]),
    ].join('\n'),
    expected: {
      expectedPks: [
        { table: 'kundenstamm', columns: ['kundennummer'] },
        { table: 'seihin', columns: ['seihin_bango'] },
      ],
      expectedLinks: [
        {
          fromTable: 'bestellungen',
          fromColumns: ['kaeufer_nummer'],
          toTable: 'kundenstamm',
          toColumns: ['kundennummer'],
          relationship: 'many_to_one',
        },
        {
          fromTable: 'uriage',
          fromColumns: ['hinban'],
          toTable: 'seihin',
          toColumns: ['seihin_bango'],
          relationship: 'many_to_one',
        },
      ],
    },
  };
}

function abbreviatedOldNamingFixture() {
  return {
    id: 'abbreviated_old_no_declared_constraints',
    name: 'Abbreviated old naming fixture with no declared constraints',
    tier: 'row_bearing',
    sql: [
      'CREATE TABLE cust (cust_id TEXT NOT NULL, nm TEXT NOT NULL, stat_cd TEXT NOT NULL);',
      insertSql('cust', ['cust_id', 'nm', 'stat_cd'], [
        ['C001', 'Acme', 'A'],
        ['C002', 'Globex', 'A'],
        ['C003', 'Initech', 'I'],
      ]),
      'CREATE TABLE prod (prod_cd TEXT NOT NULL, prod_nm TEXT NOT NULL, cat_cd TEXT NOT NULL);',
      insertSql('prod', ['prod_cd', 'prod_nm', 'cat_cd'], [
        ['P10', 'Seat', 'FURN'],
        ['P11', 'Desk', 'FURN'],
        ['P12', 'Lamp', 'HOME'],
      ]),
      'CREATE TABLE ord_hdr (ord_id TEXT NOT NULL, cust_id TEXT NOT NULL, ord_dt TEXT NOT NULL);',
      insertSql('ord_hdr', ['ord_id', 'cust_id', 'ord_dt'], [
        ['O900', 'C001', '2026-01-01'],
        ['O901', 'C001', '2026-01-02'],
        ['O902', 'C002', '2026-01-03'],
      ]),
      'CREATE TABLE ord_ln (ln_id TEXT NOT NULL, ord_id TEXT NOT NULL, prod_cd TEXT NOT NULL, qty INTEGER NOT NULL);',
      insertSql('ord_ln', ['ln_id', 'ord_id', 'prod_cd', 'qty'], [
        ['L1', 'O900', 'P10', 2],
        ['L2', 'O900', 'P12', 1],
        ['L3', 'O901', 'P11', 4],
      ]),
    ].join('\n'),
    expected: {
      expectedPks: [
        { table: 'cust', columns: ['cust_id'] },
        { table: 'ord_hdr', columns: ['ord_id'] },
        { table: 'prod', columns: ['prod_cd'] },
      ],
      expectedLinks: [
        {
          fromTable: 'ord_hdr',
          fromColumns: ['cust_id'],
          toTable: 'cust',
          toColumns: ['cust_id'],
          relationship: 'many_to_one',
        },
        {
          fromTable: 'ord_ln',
          fromColumns: ['ord_id'],
          toTable: 'ord_hdr',
          toColumns: ['ord_id'],
          relationship: 'many_to_one',
        },
        {
          fromTable: 'ord_ln',
          fromColumns: ['prod_cd'],
          toTable: 'prod',
          toColumns: ['prod_cd'],
          relationship: 'many_to_one',
        },
      ],
    },
  };
}

function analyticalWarehouseFixture() {
  return {
    id: 'analytical_warehouse_no_naming_convention',
    name: 'Analytical warehouse fixture with no naming convention',
    tier: 'row_bearing',
    sql: [
      'CREATE TABLE dim_signup_country (country_code TEXT NOT NULL, country_name TEXT NOT NULL, region_name TEXT NOT NULL);',
      insertSql('dim_signup_country', ['country_code', 'country_name', 'region_name'], [
        ['US', 'United States', 'americas'],
        ['DE', 'Germany', 'emea'],
        ['JP', 'Japan', 'apac'],
      ]),
      'CREATE TABLE dim_commercial_plan (plan_code TEXT NOT NULL, plan_family TEXT NOT NULL, sales_motion TEXT NOT NULL);',
      insertSql('dim_commercial_plan', ['plan_code', 'plan_family', 'sales_motion'], [
        ['FREE', 'free', 'self_serve'],
        ['TEAM', 'team', 'sales_assisted'],
        ['ENT', 'enterprise', 'sales_led'],
      ]),
      'CREATE TABLE mart_revenue_daily (revenue_event_key TEXT NOT NULL, signup_country_code TEXT NOT NULL, commercial_plan_code TEXT NOT NULL, booked_revenue INTEGER NOT NULL);',
      insertSql(
        'mart_revenue_daily',
        ['revenue_event_key', 'signup_country_code', 'commercial_plan_code', 'booked_revenue'],
        [
          ['R1', 'US', 'TEAM', 200],
          ['R2', 'DE', 'ENT', 900],
          ['R3', 'US', 'FREE', 0],
        ],
      ),
      'CREATE TABLE mart_activation_cohort (cohort_key TEXT NOT NULL, first_touch_country TEXT NOT NULL, purchased_plan TEXT NOT NULL, activated_accounts INTEGER NOT NULL);',
      insertSql(
        'mart_activation_cohort',
        ['cohort_key', 'first_touch_country', 'purchased_plan', 'activated_accounts'],
        [
          ['C1', 'JP', 'TEAM', 7],
          ['C2', 'DE', 'ENT', 2],
          ['C3', 'US', 'FREE', 30],
        ],
      ),
    ].join('\n'),
    expected: {
      expectedPks: [
        { table: 'dim_commercial_plan', columns: ['plan_code'] },
        { table: 'dim_signup_country', columns: ['country_code'] },
      ],
      expectedLinks: [
        {
          fromTable: 'mart_activation_cohort',
          fromColumns: ['first_touch_country'],
          toTable: 'dim_signup_country',
          toColumns: ['country_code'],
          relationship: 'many_to_one',
        },
        {
          fromTable: 'mart_activation_cohort',
          fromColumns: ['purchased_plan'],
          toTable: 'dim_commercial_plan',
          toColumns: ['plan_code'],
          relationship: 'many_to_one',
        },
        {
          fromTable: 'mart_revenue_daily',
          fromColumns: ['commercial_plan_code'],
          toTable: 'dim_commercial_plan',
          toColumns: ['plan_code'],
          relationship: 'many_to_one',
        },
        {
          fromTable: 'mart_revenue_daily',
          fromColumns: ['signup_country_code'],
          toTable: 'dim_signup_country',
          toColumns: ['country_code'],
          relationship: 'many_to_one',
        },
      ],
    },
  };
}

function mixedCaseFixture() {
  return {
    id: 'mixed_case_within_schema_no_declared_constraints',
    name: 'Mixed case within schema fixture with no declared constraints',
    tier: 'row_bearing',
    sql: [
      'CREATE TABLE CustomerAccount (AccountID TEXT NOT NULL, AccountName TEXT NOT NULL, accountTier TEXT NOT NULL);',
      insertSql('CustomerAccount', ['AccountID', 'AccountName', 'accountTier'], [
        ['A-1', 'Acme', 'team'],
        ['A-2', 'Globex', 'enterprise'],
        ['A-3', 'Initech', 'free'],
      ]),
      'CREATE TABLE subscriptionPlans (planId TEXT NOT NULL, display_name TEXT NOT NULL, BillingCadence TEXT NOT NULL);',
      insertSql('subscriptionPlans', ['planId', 'display_name', 'BillingCadence'], [
        ['P-free', 'Free', 'none'],
        ['P-team', 'Team', 'monthly'],
        ['P-ent', 'Enterprise', 'annual'],
      ]),
      'CREATE TABLE order_events (event_id TEXT NOT NULL, accountId TEXT NOT NULL, plan_id TEXT NOT NULL, amount INTEGER NOT NULL);',
      insertSql('order_events', ['event_id', 'accountId', 'plan_id', 'amount'], [
        ['E1', 'A-1', 'P-team', 120],
        ['E2', 'A-2', 'P-ent', 1000],
        ['E3', 'A-1', 'P-free', 0],
      ]),
      'CREATE TABLE InvoiceHeader (InvoiceID TEXT NOT NULL, CustomerAccountID TEXT NOT NULL, invoice_total INTEGER NOT NULL);',
      insertSql('InvoiceHeader', ['InvoiceID', 'CustomerAccountID', 'invoice_total'], [
        ['I1', 'A-1', 120],
        ['I2', 'A-2', 1000],
        ['I3', 'A-1', 20],
      ]),
      'CREATE TABLE line_items (line_item_id TEXT NOT NULL, invoice_id TEXT NOT NULL, skuCode TEXT NOT NULL);',
      insertSql('line_items', ['line_item_id', 'invoice_id', 'skuCode'], [
        ['L1', 'I1', 'SKU1'],
        ['L2', 'I1', 'SKU2'],
        ['L3', 'I2', 'SKU3'],
      ]),
    ].join('\n'),
    expected: {
      expectedPks: [
        { table: 'CustomerAccount', columns: ['AccountID'] },
        { table: 'InvoiceHeader', columns: ['InvoiceID'] },
        { table: 'subscriptionPlans', columns: ['planId'] },
      ],
      expectedLinks: [
        {
          fromTable: 'InvoiceHeader',
          fromColumns: ['CustomerAccountID'],
          toTable: 'CustomerAccount',
          toColumns: ['AccountID'],
          relationship: 'many_to_one',
        },
        {
          fromTable: 'line_items',
          fromColumns: ['invoice_id'],
          toTable: 'InvoiceHeader',
          toColumns: ['InvoiceID'],
          relationship: 'many_to_one',
        },
        {
          fromTable: 'order_events',
          fromColumns: ['accountId'],
          toTable: 'CustomerAccount',
          toColumns: ['AccountID'],
          relationship: 'many_to_one',
        },
        {
          fromTable: 'order_events',
          fromColumns: ['plan_id'],
          toTable: 'subscriptionPlans',
          toColumns: ['planId'],
          relationship: 'many_to_one',
        },
      ],
    },
  };
}

function polymorphicFixture() {
  return {
    id: 'polymorphic_partial_overlap_no_declared_constraints',
    name: 'Polymorphic partial-overlap fixture with no declared constraints',
    tier: 'row_bearing',
    sql: [
      'CREATE TABLE users (user_id TEXT NOT NULL, email TEXT NOT NULL, lifecycle TEXT NOT NULL);',
      insertSql('users', ['user_id', 'email', 'lifecycle'], [
        ['U1', 'ada@example.com', 'active'],
        ['U2', 'grace@example.com', 'active'],
        ['U3', 'alan@example.com', 'inactive'],
      ]),
      'CREATE TABLE organizations (organization_id TEXT NOT NULL, organization_name TEXT NOT NULL, market TEXT NOT NULL);',
      insertSql('organizations', ['organization_id', 'organization_name', 'market'], [
        ['O1', 'Acme', 'midmarket'],
        ['O2', 'Globex', 'enterprise'],
        ['O3', 'Initech', 'smb'],
      ]),
      'CREATE TABLE activity_events (event_id TEXT NOT NULL, entity_id TEXT NOT NULL, entity_type TEXT NOT NULL, action_name TEXT NOT NULL);',
      insertSql('activity_events', ['event_id', 'entity_id', 'entity_type', 'action_name'], [
        ['E1', 'U1', 'user', 'login'],
        ['E2', 'O1', 'organization', 'workspace_created'],
        ['E3', 'U2', 'user', 'invite_sent'],
        ['E4', 'O2', 'organization', 'billing_updated'],
      ]),
    ].join('\n'),
    expected: {
      expectedPks: [
        { table: 'organizations', columns: ['organization_id'] },
        { table: 'users', columns: ['user_id'] },
      ],
      expectedLinks: [
        {
          fromTable: 'activity_events',
          fromColumns: ['entity_id'],
          toTable: 'organizations',
          toColumns: ['organization_id'],
          relationship: 'many_to_one',
        },
        {
          fromTable: 'activity_events',
          fromColumns: ['entity_id'],
          toTable: 'users',
          toColumns: ['user_id'],
          relationship: 'many_to_one',
        },
      ],
    },
  };
}

function padded(value, width) {
  return String(value).padStart(width, '0');
}

function scaleFixture() {
  const statements = [];
  const expectedPks = [];
  const expectedLinks = [];
  const dimensionCount = 20;
  const factCount = 380;

  for (let dim = 0; dim < dimensionCount; dim += 1) {
    const dimId = padded(dim, 2);
    const table = `dim_entity_${dimId}`;
    const key = `entity_${dimId}_key`;
    const columns = [key, ...Array.from({ length: 49 }, (_, index) => `attribute_${padded(index, 2)}`)];
    statements.push(`CREATE TABLE ${q(table)} (${columns.map((column) => `${q(column)} TEXT NOT NULL`).join(', ')});`);
    statements.push(
      insertSql(
        table,
        columns,
        Array.from({ length: 3 }, (_, rowIndex) => [
          `D${dimId}-${rowIndex}`,
          ...Array.from({ length: 49 }, (_, attrIndex) => `dim${dimId}_attr${attrIndex}_${rowIndex}`),
        ]),
      ),
    );
    expectedPks.push({ table, columns: [key] });
  }

  for (let fact = 0; fact < factCount; fact += 1) {
    const factId = padded(fact, 3);
    const table = `fact_activity_${factId}`;
    const referencedDims = Array.from({ length: 5 }, (_, offset) => (fact + offset) % dimensionCount);
    const referenceColumns = referencedDims.map((dim) => `entity_${padded(dim, 2)}_key`);
    const metricColumns = Array.from({ length: 44 }, (_, index) => `metric_${padded(index, 2)}`);
    const columns = ['event_id', ...referenceColumns, ...metricColumns];
    statements.push(
      `CREATE TABLE ${q(table)} (${[
        `${q('event_id')} TEXT NOT NULL`,
        ...referenceColumns.map((column) => `${q(column)} TEXT NOT NULL`),
        ...metricColumns.map((column) => `${q(column)} INTEGER NOT NULL`),
      ].join(', ')});`,
    );
    statements.push(
      insertSql(
        table,
        columns,
        Array.from({ length: 3 }, (_, rowIndex) => [
          `F${factId}-${rowIndex}`,
          ...referencedDims.map((dim) => `D${padded(dim, 2)}-${rowIndex}`),
          ...metricColumns.map((_, metricIndex) => fact * 1000 + metricIndex * 10 + rowIndex),
        ]),
      ),
    );

    for (const dim of referencedDims) {
      const dimId = padded(dim, 2);
      expectedLinks.push({
        fromTable: table,
        fromColumns: [`entity_${dimId}_key`],
        toTable: `dim_entity_${dimId}`,
        toColumns: [`entity_${dimId}_key`],
        relationship: 'many_to_one',
      });
    }
  }

  return {
    id: 'scale_stress_no_declared_constraints',
    name: 'Scale stress fixture with no declared constraints',
    tier: 'row_bearing',
    validationBudget: 800,
    compressArtifacts: true,
    sql: statements.join('\n'),
    expected: { expectedPks, expectedLinks },
  };
}

const fixtures = [
  nonEnglishFixture(),
  abbreviatedOldNamingFixture(),
  analyticalWarehouseFixture(),
  mixedCaseFixture(),
  polymorphicFixture(),
  scaleFixture(),
];

for (const fixture of fixtures) {
  writeFixture(fixture);
}
