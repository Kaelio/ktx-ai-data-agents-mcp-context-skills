import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  buildOrbitScanArgs,
  defaultOrbitVerificationProjectDir,
  extractReportPath,
  extractRunId,
  formatOrbitVerificationMarkdown,
  runOrbitVerification,
} from './relationship-orbit-verification.mjs';

function successReportJson() {
  return JSON.stringify({
    runId: 'scan-orbit-1',
    connectionId: 'orbit',
    mode: 'enriched',
    syncId: '2026-05-07-100000-scan-enriched-1',
    relationships: {
      accepted: 14,
      review: 8,
      rejected: 91,
      skipped: 0,
    },
    enrichment: {
      deterministicRelationships: 'completed',
      statisticalValidation: 'completed',
      llmRelationshipValidation: 'skipped',
    },
    warnings: [
      {
        code: 'scan_enrichment_backend_not_configured',
        message:
          'Skipping description and embedding enrichment because scan.enrichment.mode is not configured; relationship discovery still ran.',
        recoverable: true,
      },
    ],
    artifactPaths: {
      reportPath: 'raw-sources/orbit/live-database/2026-05-07-100000-scan-enriched-1/reports/scan-report.json',
      rawSourcesDir: 'raw-sources/orbit/live-database/2026-05-07-100000-scan-enriched-1',
      manifestShards: ['semantic-layer/orbit/_schema/orbit_analytics.yaml'],
      enrichmentArtifacts: [
        'raw-sources/orbit/live-database/2026-05-07-100000-scan-enriched-1/enrichment/relationships.json',
        'raw-sources/orbit/live-database/2026-05-07-100000-scan-enriched-1/enrichment/relationship-profile.json',
        'raw-sources/orbit/live-database/2026-05-07-100000-scan-enriched-1/enrichment/relationship-diagnostics.json',
      ],
    },
  });
}

function successfulRunKtxScan(calls = []) {
  return async (args, io) => {
    calls.push(args);
    io.stdout.write('KTX scan completed\nRun: scan-orbit-1\nConnection: orbit\n  Report: reports/scan-report.json\n');
    return 0;
  };
}

describe('relationship Orbit verification helper', () => {
  it('exposes the Orbit verification command from the KTX workspace package', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.equal(
      packageJson.scripts['relationships:verify-orbit'],
      'node scripts/relationship-orbit-verification.mjs',
    );
  });

  it('builds the internal relationship scan arguments', () => {
    assert.deepEqual(buildOrbitScanArgs({ connectionId: 'orbit', projectDir: '/tmp/orbit-project' }), {
      command: 'run',
      projectDir: '/tmp/orbit-project',
      connectionId: 'orbit',
      mode: 'relationships',
      detectRelationships: true,
      dryRun: false,
    });
  });

  it('uses the checked-in Orbit verification project by default', async () => {
    const scanCalls = [];
    const writes = [];
    const defaultProjectDir = defaultOrbitVerificationProjectDir();

    const result = await runOrbitVerification({
      reportPath: '/tmp/orbit-report.md',
      now: () => new Date('2026-05-07T10:00:00.000Z'),
      mkdir: async () => {},
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
      runKtxScan: successfulRunKtxScan(scanCalls),
      readFile: async () => successReportJson(),
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(scanCalls, [
      {
        command: 'run',
        projectDir: defaultProjectDir,
        connectionId: 'orbit',
        mode: 'relationships',
        detectRelationships: true,
        dryRun: false,
      },
    ]);
    assert.equal(writes.length, 1);
    assert.match(writes[0].content, new RegExp(defaultProjectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('uses KTX_PROJECT_DIR for the Orbit verification project override', async () => {
    const previousProjectDir = process.env.KTX_PROJECT_DIR;
    const scanCalls = [];

    try {
      process.env.KTX_PROJECT_DIR = '/tmp/orbit-project-from-env';

      const result = await runOrbitVerification({
        reportPath: '/tmp/orbit-report.md',
        now: () => new Date('2026-05-07T10:00:00.000Z'),
        mkdir: async () => {},
        writeFile: async () => {},
        runKtxScan: successfulRunKtxScan(scanCalls),
        readFile: async () => successReportJson(),
      });

      assert.equal(result.projectDir, '/tmp/orbit-project-from-env');
      assert.deepEqual(scanCalls, [
        {
          command: 'run',
          projectDir: '/tmp/orbit-project-from-env',
          connectionId: 'orbit',
          mode: 'relationships',
          detectRelationships: true,
          dryRun: false,
        },
      ]);
    } finally {
      if (previousProjectDir === undefined) {
        delete process.env.KTX_PROJECT_DIR;
      } else {
        process.env.KTX_PROJECT_DIR = previousProjectDir;
      }
    }
  });

  it('extracts the run id from human scan output', () => {
    assert.equal(extractRunId(`KTX scan completed\nStatus: done\nRun: scan-orbit-1\nConnection: orbit\n`), 'scan-orbit-1');
    assert.equal(extractRunId('KTX scan completed without a run line\n'), null);
    assert.equal(extractReportPath('Artifacts\n  Report: reports/scan-report.json\n'), 'reports/scan-report.json');
  });

  it('formats successful Orbit verification evidence from the JSON report', () => {
    const markdown = formatOrbitVerificationMarkdown({
      status: 'success',
      date: '2026-05-07',
      connectionId: 'orbit',
      projectDir: '/tmp/orbit-project',
      scanCommand: 'internal runKtxScan connection=orbit mode=relationships projectDir=/tmp/orbit-project',
      reportPath: '/tmp/orbit-project/reports/scan-report.json',
      scanExitCode: 0,
      scanStdout: 'KTX scan completed\nRun: scan-orbit-1\n',
      scanStderr: '',
      report: JSON.parse(successReportJson()),
    });

    assert.match(markdown, /# KTX Relationship Discovery Orbit Verification/);
    assert.match(markdown, /Outcome/);
    assert.match(markdown, /Exit code: 0/);
    assert.match(markdown, /Accepted: 14/);
    assert.match(markdown, /Review: 8/);
    assert.match(markdown, /Rejected: 91/);
    assert.match(markdown, /semantic-layer\/orbit\/_schema\/orbit_analytics\.yaml/);
    assert.match(markdown, /relationship-diagnostics\.json/);
    assert.match(markdown, /scan_enrichment_backend_not_configured/);
  });

  it('formats blocked Orbit verification evidence from the current failing command', () => {
    const markdown = formatOrbitVerificationMarkdown({
      status: 'blocked',
      date: '2026-05-07',
      connectionId: 'orbit',
      projectDir: '/tmp/orbit-project',
      scanCommand: 'internal runKtxScan connection=orbit mode=relationships projectDir=/tmp/orbit-project',
      scanExitCode: 1,
      blocker: 'Connection "orbit" was not found',
      scanStdout: '',
      scanStderr: 'Connection "orbit" was not found\n',
    });

    assert.match(markdown, /Exit code: 1/);
    assert.match(markdown, /Connection "orbit" was not found/);
    assert.match(markdown, /Orbit verification was not executed because the current local Orbit relationship scan failed/);
    assert.doesNotMatch(markdown, /scan\.enrichment\.mode is required/);
  });

  it('runs scan then reads the report artifact and writes success Markdown', async () => {
    const scanCalls = [];
    const writes = [];
    const result = await runOrbitVerification({
      connectionId: 'orbit',
      projectDir: '/tmp/orbit-project',
      reportPath: '/tmp/orbit-report.md',
      now: () => new Date('2026-05-07T10:00:00.000Z'),
      mkdir: async () => {},
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
      runKtxScan: successfulRunKtxScan(scanCalls),
      readFile: async () => successReportJson(),
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(scanCalls, [
      {
        command: 'run',
        projectDir: '/tmp/orbit-project',
        connectionId: 'orbit',
        mode: 'relationships',
        detectRelationships: true,
        dryRun: false,
      },
    ]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/tmp/orbit-report.md');
    assert.match(writes[0].content, /Accepted: 14/);
  });

  it('writes blocked Markdown when the internal scan fails before a run id exists', async () => {
    const writes = [];
    const result = await runOrbitVerification({
      connectionId: 'orbit',
      projectDir: '/tmp/orbit-project',
      reportPath: '/tmp/orbit-report.md',
      now: () => new Date('2026-05-07T10:00:00.000Z'),
      mkdir: async () => {},
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
      runKtxScan: async (_args, io) => {
        io.stderr.write('Connection "orbit" was not found\n');
        return 1;
      },
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.scanExitCode, 1);
    assert.equal(writes.length, 1);
    assert.match(writes[0].content, /Connection "orbit" was not found/);
  });

  it('runs the workspace launcher in buffered mode when preparing the internal scan module', async () => {
    let sawExecFile = false;
    const result = await runOrbitVerification({
      connectionId: 'orbit',
      projectDir: '/tmp/orbit-project',
      reportPath: '/tmp/orbit-report.md',
      now: () => new Date('2026-05-07T10:00:00.000Z'),
      mkdir: async () => {},
      writeFile: async () => {},
      execFile: async () => ({ stdout: '', stderr: '' }),
      runWorkspaceKtx: async (argv, options) => {
        assert.deepEqual(argv, ['--version']);
        sawExecFile = typeof options.execFile === 'function';
        options.stderr.write('ENOENT: no such file or directory, open \'/tmp/orbit-project/ktx.yaml\'\n');
        return 1;
      },
    });

    assert.equal(sawExecFile, true);
    assert.equal(result.blocker, "ENOENT: no such file or directory, open '/tmp/orbit-project/ktx.yaml'");
  });
});
