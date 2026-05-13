#!/usr/bin/env node

import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { execFile as childExecFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runWorkspaceKtx } from './run-ktx.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ktxRootDir = resolve(scriptDir, '..');
const repoRootDir = resolve(ktxRootDir, '..');
const defaultProjectDir = resolve(ktxRootDir, 'examples/orbit-relationship-verification');
const defaultReportPath = resolve(
  ktxRootDir,
  'examples/orbit-relationship-verification/reports/orbit-verification.md',
);
const defaultExecFile = promisify(childExecFile);

class BufferWriter {
  chunks = [];

  write(chunk) {
    this.chunks.push(String(chunk));
  }

  text() {
    return this.chunks.join('');
  }
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function trimForReport(value) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'none';
}

export function defaultOrbitVerificationProjectDir() {
  return defaultProjectDir;
}

function shellCommand(argv) {
  return ['pnpm', 'run', 'ktx', '--', ...argv].join(' ');
}

function firstNonEmptyLine(...values) {
  for (const value of values) {
    const line = value
      .split('\n')
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0);
    if (line) {
      return line;
    }
  }
  return 'Orbit scan command failed before producing diagnostic output';
}

function parseArgs(argv) {
  const options = {
    connectionId: process.env.KTX_ORBIT_CONNECTION_ID ?? 'orbit',
    projectDir: process.env.KTX_PROJECT_DIR ?? defaultProjectDir,
    reportPath: defaultReportPath,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--connection-id' || arg === '--connection') {
      options.connectionId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--project-dir') {
      options.projectDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--report-path') {
      options.reportPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

export function buildOrbitScanArgv(input) {
  return ['scan', input.connectionId, '--mode', 'relationships', '--project-dir', input.projectDir];
}

export function extractRunId(stdout) {
  const match = stdout.match(/^Run:\s*(\S+)/m);
  return match?.[1] ?? null;
}

export function extractReportPath(stdout) {
  const match = stdout.match(/^\s*Report:\s*(\S+)/m);
  return match?.[1] ?? null;
}

function listLines(values) {
  if (!values || values.length === 0) {
    return ['- none'];
  }
  return values.map((value) => `- \`${value}\``);
}

function warningLines(report) {
  if (!Array.isArray(report.warnings) || report.warnings.length === 0) {
    return ['- none'];
  }
  return report.warnings.map((warning) => `- \`${warning.code}\`: ${warning.message}`);
}

function formatSuccess(result) {
  const relationships = result.report.relationships ?? { accepted: 0, review: 0, rejected: 0, skipped: 0 };
  const enrichment = result.report.enrichment ?? {};
  const artifactPaths = result.report.artifactPaths ?? {};

  return [
    '## Outcome',
    '',
    '- Exit code: 0',
    `- Run: \`${result.report.runId ?? 'unknown'}\``,
    `- Connection: \`${result.report.connectionId ?? result.connectionId}\``,
    `- Mode: \`${result.report.mode ?? 'unknown'}\``,
    `- Sync: \`${result.report.syncId ?? 'unknown'}\``,
    '',
    '## Relationship Summary',
    '',
    `- Accepted: ${relationships.accepted ?? 0}`,
    `- Review: ${relationships.review ?? 0}`,
    `- Rejected: ${relationships.rejected ?? 0}`,
    `- Skipped: ${relationships.skipped ?? 0}`,
    '',
    '## Enrichment Summary',
    '',
    `- Deterministic relationships: \`${enrichment.deterministicRelationships ?? 'unknown'}\``,
    `- Statistical validation: \`${enrichment.statisticalValidation ?? 'unknown'}\``,
    `- LLM relationship validation: \`${enrichment.llmRelationshipValidation ?? 'unknown'}\``,
    '',
    '## Artifacts',
    '',
    `- Report: \`${artifactPaths.reportPath ?? 'none'}\``,
    `- Raw sources: \`${artifactPaths.rawSourcesDir ?? 'none'}\``,
    '',
    'Manifest shards:',
    '',
    ...listLines(artifactPaths.manifestShards),
    '',
    'Enrichment artifacts:',
    '',
    ...listLines(artifactPaths.enrichmentArtifacts),
    '',
    'Warnings:',
    '',
    ...warningLines(result.report),
  ];
}

function formatBlocked(result) {
  return [
    '## Outcome',
    '',
    `- Exit code: ${result.scanExitCode}`,
    `- Blocker: \`${result.blocker}\``,
    '',
    '## Evidence',
    '',
    '- Orbit verification was not executed because the current local Orbit scan command failed.',
    '- Re-run with `--report-path` to write verification evidence to a custom location.',
    '',
    'Scan stdout:',
    '',
    '```text',
    trimForReport(result.scanStdout),
    '```',
    '',
    'Scan stderr:',
    '',
    '```text',
    trimForReport(result.scanStderr),
    '```',
  ];
}

export function formatOrbitVerificationMarkdown(result) {
  const lines = [
    '# KTX Relationship Discovery Orbit Verification',
    '',
    `Date: ${result.date}`,
    '',
    '## Command',
    '',
    '```bash',
    result.scanCommand,
    '```',
    '',
  ];

  if (result.status === 'success') {
    lines.push(
      '## Scan Report Artifact',
      '',
      `- ${result.reportPath}`,
      '',
      ...formatSuccess(result),
    );
  } else {
    lines.push(...formatBlocked(result));
  }

  return `${lines.join('\n')}\n`;
}

async function runBufferedWorkspaceKtx(runner, argv, rootDir, execFile) {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const exitCode = await runner(argv, { rootDir, execFile, stdout, stderr });
  return {
    exitCode,
    stdout: stdout.text(),
    stderr: stderr.text(),
  };
}

function orbitVerificationEnv(projectDir) {
  if (projectDir !== defaultProjectDir) {
    return process.env;
  }
  return {
    ...process.env,
    GIT_CEILING_DIRECTORIES: dirname(defaultProjectDir),
  };
}

export async function runOrbitVerification(options = {}) {
  const connectionId = options.connectionId ?? process.env.KTX_ORBIT_CONNECTION_ID ?? 'orbit';
  const projectDir = options.projectDir ?? process.env.KTX_PROJECT_DIR ?? defaultProjectDir;
  const reportPath = options.reportPath ?? defaultReportPath;
  const rootDir = options.rootDir ?? ktxRootDir;
  const runner = options.runWorkspaceKtx ?? runWorkspaceKtx;
  const execFile = options.execFile ?? defaultExecFile;
  const now = options.now ?? (() => new Date());
  const mkdir = options.mkdir ?? fsMkdir;
  const writeFile = options.writeFile ?? fsWriteFile;
  const readFile = options.readFile ?? fsReadFile;
  const date = dateOnly(now());
  const env = options.env ?? orbitVerificationEnv(projectDir);
  const runWithEnv = (argv, runnerOptions) => runner(argv, { ...runnerOptions, env });

  const scanArgv = buildOrbitScanArgv({ connectionId, projectDir });
  const scan = await runBufferedWorkspaceKtx(runWithEnv, scanArgv, rootDir, execFile);
  let result;

  if (scan.exitCode !== 0) {
    result = {
      status: 'blocked',
      date,
      connectionId,
      projectDir,
      scanCommand: shellCommand(scanArgv),
      scanExitCode: scan.exitCode,
      blocker: firstNonEmptyLine(scan.stderr, scan.stdout),
      scanStdout: scan.stdout,
      scanStderr: scan.stderr,
    };
  } else {
    const runId = extractRunId(scan.stdout);
    if (!runId) {
      result = {
        status: 'blocked',
        date,
        connectionId,
        projectDir,
        scanCommand: shellCommand(scanArgv),
        scanExitCode: scan.exitCode,
        blocker: 'KTX scan completed without printing a Run id',
        scanStdout: scan.stdout,
        scanStderr: scan.stderr,
      };
    } else {
      const scanReportPath = extractReportPath(scan.stdout);
      if (!scanReportPath) {
        result = {
          status: 'blocked',
          date,
          connectionId,
          projectDir,
          scanCommand: shellCommand(scanArgv),
          scanExitCode: scan.exitCode,
          blocker: 'KTX scan completed without printing a report artifact path',
          scanStdout: scan.stdout,
          scanStderr: scan.stderr,
        };
      } else {
        const fullScanReportPath = resolve(projectDir, scanReportPath);
        result = {
          status: 'success',
          date,
          connectionId,
          projectDir,
          scanCommand: shellCommand(scanArgv),
          reportPath: fullScanReportPath,
          scanExitCode: scan.exitCode,
          scanStdout: scan.stdout,
          scanStderr: scan.stderr,
          report: JSON.parse(await readFile(fullScanReportPath, 'utf8')),
        };
      }
    }
  }

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, formatOrbitVerificationMarkdown(result));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runOrbitVerification(options);
  process.stdout.write(`Wrote ${options.reportPath}\n`);
  process.stdout.write(`Outcome: ${result.status}\n`);
}
