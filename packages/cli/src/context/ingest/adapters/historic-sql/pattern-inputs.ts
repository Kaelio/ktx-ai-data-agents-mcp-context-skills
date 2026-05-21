import { Buffer } from 'node:buffer';
import type { StagedPatternsInput } from './types.js';

const HISTORIC_SQL_PATTERN_WORKUNIT_DIR = 'patterns-input';
/** @internal */
export const HISTORIC_SQL_PATTERN_WORKUNIT_MAX_BYTES = 110_000;
const HISTORIC_SQL_PATTERN_WORKUNIT_PATH_RE = /^patterns-input\/part-\d{4}\.json$/;

type PatternTemplate = StagedPatternsInput['templates'][number];

interface HistoricSqlPatternInputShard {
  path: string;
  input: StagedPatternsInput;
  byteLength: number;
}

export interface HistoricSqlPatternInputSplitResult {
  auditInput: StagedPatternsInput;
  shards: HistoricSqlPatternInputShard[];
  warnings: string[];
}

export interface HistoricSqlPatternInputSplitOptions {
  maxBytes?: number;
}

export function isHistoricSqlPatternInputShardPath(path: string): boolean {
  return HISTORIC_SQL_PATTERN_WORKUNIT_PATH_RE.test(path);
}

function serializeStagedPatternsInput(input: StagedPatternsInput): string {
  return `${JSON.stringify(input, null, 2)}\n`;
}

/** @internal */
export function serializedStagedPatternsInputByteLength(input: StagedPatternsInput): number {
  return Buffer.byteLength(serializeStagedPatternsInput(input), 'utf-8');
}

function sortedAuditTemplates(templates: readonly PatternTemplate[]): PatternTemplate[] {
  return [...templates].sort((left, right) => left.id.localeCompare(right.id));
}

function sortedPatternCandidates(templates: readonly PatternTemplate[]): PatternTemplate[] {
  return [...templates]
    .filter((template) => template.tablesTouched.length >= 2)
    .map((template) => ({ ...template, tablesTouched: [...template.tablesTouched].sort() }))
    .sort((left, right) => {
      const cardinality = right.tablesTouched.length - left.tablesTouched.length;
      if (cardinality !== 0) return cardinality;
      const tableSignature = left.tablesTouched.join('\0').localeCompare(right.tablesTouched.join('\0'));
      if (tableSignature !== 0) return tableSignature;
      return left.id.localeCompare(right.id);
    });
}

function shardPath(index: number): string {
  return `${HISTORIC_SQL_PATTERN_WORKUNIT_DIR}/part-${String(index).padStart(4, '0')}.json`;
}

export function splitHistoricSqlPatternInputs(
  input: StagedPatternsInput,
  options: HistoricSqlPatternInputSplitOptions = {},
): HistoricSqlPatternInputSplitResult {
  const maxBytes = options.maxBytes ?? HISTORIC_SQL_PATTERN_WORKUNIT_MAX_BYTES;
  const auditInput: StagedPatternsInput = { templates: sortedAuditTemplates(input.templates) };
  const warnings: string[] = [];
  const shards: HistoricSqlPatternInputShard[] = [];
  let current: PatternTemplate[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const shardInput: StagedPatternsInput = { templates: current };
    shards.push({
      path: shardPath(shards.length + 1),
      input: shardInput,
      byteLength: serializedStagedPatternsInputByteLength(shardInput),
    });
    current = [];
  };

  for (const template of sortedPatternCandidates(input.templates)) {
    const singleInput: StagedPatternsInput = { templates: [template] };
    if (serializedStagedPatternsInputByteLength(singleInput) > maxBytes) {
      warnings.push(`patterns_input_template_too_large:${template.id}`);
      continue;
    }

    const nextInput: StagedPatternsInput = { templates: [...current, template] };
    if (current.length > 0 && serializedStagedPatternsInputByteLength(nextInput) > maxBytes) {
      flush();
    }
    current.push(template);
  }

  flush();

  return { auditInput, shards, warnings };
}
