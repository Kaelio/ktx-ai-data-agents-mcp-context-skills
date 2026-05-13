import type { Tool, ToolSet } from 'ai';
import { buildCanonicalPinsPromptBlock, type CanonicalPin } from '../canonical-pins.js';
import { createLookerQueryToSlTool } from '../adapters/looker/tools/looker-query-to-sl.tool.js';
import type { IngestProvenanceRow } from '../ports.js';
import { createReadRawFileTool } from '../tools/read-raw-file.tool.js';
import { createReadRawSpanTool } from '../tools/read-raw-span.tool.js';
import {
  createVerificationLedgerState,
  VERIFICATION_LEDGER_PROMPT,
  withVerificationLedger,
} from '../tools/verification-ledger.tool.js';
import type { WorkUnit } from '../types.js';

const PEER_FILE_INDEX_PROMPT_LIMIT = 100;

export interface BuildWuPromptInput {
  wu: WorkUnit;
  wikiIndex: string;
  slIndex: string;
  priorProvenance: Map<string, IngestProvenanceRow[]>;
}

export function buildWuSystemPrompt(params: {
  baseFraming: string;
  skillsPrompt: string;
  syncId: string;
  sourceKey: string;
  canonicalPins?: CanonicalPin[];
}): string {
  const parts = [
    params.baseFraming.trimEnd(),
    VERIFICATION_LEDGER_PROMPT,
    params.skillsPrompt.trimEnd(),
    buildCanonicalPinsPromptBlock(params.canonicalPins ?? []),
    `\n<context>\nsyncId: ${params.syncId}\nsource: ${params.sourceKey}\n</context>`,
  ];
  return parts.filter(Boolean).join('\n');
}

export function buildWuUserPrompt(input: BuildWuPromptInput): string {
  const { wu, wikiIndex, slIndex, priorProvenance } = input;
  const hasPrior = [...priorProvenance.values()].some((rows) => rows.length > 0);
  const priorBlock = hasPrior
    ? [
        '### priorProvenance',
        ...[...priorProvenance.entries()]
          .filter(([, rows]) => rows.length > 0)
          .map(([path, rows]) => {
            const artifacts = rows
              .map((r) => `    - kind: ${r.artifact_kind} key: ${r.artifact_key} action: ${r.action_type}`)
              .join('\n');
            return `- raw_path: ${path}\n  prior_sync_id: ${rows[0].sync_id}\n  artifacts:\n${artifacts}`;
          }),
      ].join('\n')
    : '';
  const sections: string[] = [];
  if (wikiIndex) {
    sections.push(`# Wiki Index\n\n${wikiIndex}`);
  }
  if (slIndex) {
    sections.push(`# Semantic Layer Sources\n\n${slIndex}`);
  }
  sections.push('---');
  sections.push(`## WorkUnit: ${wu.unitKey}`);
  sections.push(`### rawFiles\n${wu.rawFiles.map((p) => `- ${p}`).join('\n')}`);
  if (wu.dependencyPaths.length > 0) {
    sections.push(`### dependencyPaths\n${wu.dependencyPaths.map((p) => `- ${p}`).join('\n')}`);
  }
  if (wu.peerFileIndex.length > 0) {
    const visiblePeerFiles = wu.peerFileIndex.slice(0, PEER_FILE_INDEX_PROMPT_LIMIT);
    const omittedCount = wu.peerFileIndex.length - visiblePeerFiles.length;
    const peerLines = visiblePeerFiles.map((p) => `- ${p}`);
    if (omittedCount > 0) {
      peerLines.push(`- (${omittedCount} more peer files omitted)`);
    }
    sections.push(`### peerFileIndex\n${peerLines.join('\n')}`);
  }
  if (priorBlock) {
    sections.push(priorBlock);
  }
  if (wu.notes) {
    sections.push(`### notes\n${wu.notes}`);
  }
  return sections.join('\n\n');
}

export interface BuildWuToolSetInput {
  sourceKey?: string;
  stagedDir: string;
  wu: WorkUnit;
  loadSkillTool: Record<string, Tool>;
  emitUnmappedFallbackTool: Record<string, Tool>;
  toolsetTools: ToolSet;
}

function withoutWriteSlTools(toolset: ToolSet, wu: WorkUnit): ToolSet {
  if (!wu.slDisallowed) {
    return toolset;
  }
  const next = { ...toolset };
  delete next.sl_write_source;
  delete next.sl_edit_source;
  return next;
}

export function buildWuToolSet(input: BuildWuToolSetInput): ToolSet {
  const allowedPaths = new Set<string>([...input.wu.rawFiles, ...input.wu.dependencyPaths]);
  const lookerTools: ToolSet = input.sourceKey === 'looker' ? { looker_query_to_sl: createLookerQueryToSlTool() } : {};
  const state = createVerificationLedgerState();
  return withVerificationLedger(
    withoutWriteSlTools(
      {
        ...input.toolsetTools,
        ...lookerTools,
        ...input.loadSkillTool,
        ...input.emitUnmappedFallbackTool,
        read_raw_file: createReadRawFileTool({ stagedDir: input.stagedDir, allowedPaths }),
        read_raw_span: createReadRawSpanTool({ stagedDir: input.stagedDir, allowedPaths }),
      },
      input.wu,
    ),
    state,
  );
}
