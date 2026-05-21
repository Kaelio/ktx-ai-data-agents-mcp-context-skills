import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod';
import type { SourceFetchReport } from '../../types.js';
import type { ParsedLookmlProject } from './parse.js';

/** @internal */
export const LOOKML_FETCH_REPORT_FILE = 'lookml-fetch-report.json';
/** @internal */
export const LOOKML_MISMATCHED_MODELS_FILE = 'lookml-mismatched-models.json';

const fetchIssueKindSchema = z.enum([
  'unmapped_looker_connection',
  'unparseable_sql_table_name',
  'looker_template_unresolved',
  'derived_table_not_supported',
  'lookml_connection_mismatch',
]);

const fetchIssueSchema = z.object({
  rawPath: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().nullable(),
  severity: z.enum(['warning', 'error']),
  statusCode: z.number().int().nullable(),
  message: z.string().min(1),
  retryRecommended: z.boolean(),
  kind: fetchIssueKindSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const fetchReportSchema = z.object({
  status: z.enum(['success', 'partial']),
  retryRecommended: z.boolean(),
  skipped: z.array(fetchIssueSchema),
  warnings: z.array(fetchIssueSchema),
});

const mismatchedModelsSchema = z.object({
  modelNames: z.array(z.string().min(1)).default([]),
});

interface LookmlValidationArtifacts {
  report: SourceFetchReport;
  mismatchedModelNames: string[];
}

export function buildLookmlValidationArtifacts(
  project: ParsedLookmlProject,
  config: { expectedLookerConnectionName: string | null },
): LookmlValidationArtifacts {
  const expected = config.expectedLookerConnectionName;
  if (!expected) {
    return {
      report: { status: 'success', retryRecommended: false, skipped: [], warnings: [] },
      mismatchedModelNames: [],
    };
  }

  const mismatched = project.models
    .filter((model) => model.connectionName !== null && model.connectionName !== expected)
    .sort((a, b) => a.name.localeCompare(b.name));

  const warnings = mismatched.map((model) => {
    const declared = model.connectionName ?? '(none)';
    return {
      rawPath: model.path,
      entityType: 'lookml_models',
      entityId: model.name,
      severity: 'warning' as const,
      statusCode: null,
      message: `LookML model ${model.name} declares connection ${declared} but this warehouse expects ${expected}; SL writes are disabled for this model.`,
      retryRecommended: false,
      kind: 'lookml_connection_mismatch' as const,
      details: { model: model.name, declared, expected },
    };
  });

  return {
    report: {
      status: warnings.length > 0 ? 'partial' : 'success',
      retryRecommended: false,
      skipped: [],
      warnings,
    },
    mismatchedModelNames: mismatched.map((model) => model.name),
  };
}

export async function writeLookmlValidationArtifacts(
  stagedDir: string,
  artifacts: LookmlValidationArtifacts,
): Promise<void> {
  const reportPath = join(stagedDir, LOOKML_FETCH_REPORT_FILE);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(fetchReportSchema.parse(artifacts.report), null, 2)}\n`, 'utf-8');
  await writeFile(
    join(stagedDir, LOOKML_MISMATCHED_MODELS_FILE),
    `${JSON.stringify({ modelNames: artifacts.mismatchedModelNames }, null, 2)}\n`,
    'utf-8',
  );
}

export async function readLookmlFetchReport(stagedDir: string): Promise<SourceFetchReport | null> {
  try {
    const raw = await readFile(join(stagedDir, LOOKML_FETCH_REPORT_FILE), 'utf-8');
    return fetchReportSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function readLookmlMismatchedModelNames(stagedDir: string): Promise<Set<string>> {
  try {
    const raw = await readFile(join(stagedDir, LOOKML_MISMATCHED_MODELS_FILE), 'utf-8');
    const parsed = mismatchedModelsSchema.parse(JSON.parse(raw));
    return new Set(parsed.modelNames);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
}
