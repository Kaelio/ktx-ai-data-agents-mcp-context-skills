import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';
import { z } from 'zod';
import { createAgentTool, type AgentToolSet, type RunLoopToolFailure } from '../agent/index.js';
import { type KtxLogger, noopLogger } from '../core/index.js';
import type { CaptureSession, MemoryAction } from '../memory/index.js';
import type { SemanticLayerService, SemanticLayerSource, SlValidationDeps } from '../sl/index.js';
import { createTouchedSlSources, type ToolContext, type ToolSession } from '../tools/index.js';
import { actionTargetConnectionId } from './action-identity.js';
import { NOTION_DEFAULT_MAX_KNOWLEDGE_CREATES_PER_RUN } from './adapters/notion/types.js';
import { selectRelevantCanonicalPins } from './canonical-pins.js';
import { sanitizeMemoryFlowError } from './memory-flow/live-buffer.js';
import type { MemoryFlowPlannedWorkUnit } from './memory-flow/types.js';
import type { ContextEvidenceIndexSummary, IngestBundleRunnerDeps, PageTriageRunResult } from './ports.js';
import { buildSyncId, rawSourcesDirForSync } from './raw-sources-paths.js';
import {
  buildStageIndexFromReportBody,
  postProcessorSavedMemoryCounts,
  type IngestReportPostProcessorOutcome,
  type IngestReportSnapshot,
} from './reports.js';
import {
  buildReconcileSystemPrompt,
  buildReconcileToolSet,
  buildReconcileUserPrompt,
} from './stages/build-reconcile-context.js';
import { buildWuSystemPrompt, buildWuToolSet, buildWuUserPrompt } from './stages/build-wu-context.js';
import { stageRawFilesStage1 } from './stages/stage-1-stage-raw-files.js';
import { executeWorkUnit, type WorkUnitOutcome } from './stages/stage-3-work-units.js';
import { runReconciliationStage4 } from './stages/stage-4-reconciliation.js';
import type { StageIndex } from './stages/stage-index.types.js';
import { validateWuTouchedSources } from './stages/validate-wu-sources.js';
import { createEmitArtifactResolutionTool } from './tools/emit-artifact-resolution.tool.js';
import { createEmitConflictResolutionTool } from './tools/emit-conflict-resolution.tool.js';
import { createEmitEvictionDecisionTool } from './tools/emit-eviction-decision.tool.js';
import { createEmitUnmappedFallbackTool } from './tools/emit-unmapped-fallback.tool.js';
import { createEvictionListTool } from './tools/eviction-list.tool.js';
import { createReadRawSpanTool } from './tools/read-raw-span.tool.js';
import { createStageDiffTool } from './tools/stage-diff.tool.js';
import { createStageListTool } from './tools/stage-list.tool.js';
import { type ToolCallLogEntry, wrapToolsWithLogger } from './tools/tool-call-logger.js';
import {
  createMutableToolTranscriptSummary,
  recordToolTranscriptEntry,
  type MutableToolTranscriptSummary,
} from './tools/tool-transcript-summary.js';
import type {
  EvictionUnit,
  IngestBundleJob,
  IngestBundleResult,
  IngestJobContext,
  UnresolvedCardInfo,
  WorkUnit,
} from './types.js';
import { repairWikiSlRefs, type WikiSlRefRepairResult } from './wiki-sl-ref-repair.js';

function workUnitToMemoryFlowPlannedWorkUnit(workUnit: WorkUnit): MemoryFlowPlannedWorkUnit {
  return {
    unitKey: workUnit.unitKey,
    rawFiles: workUnit.rawFiles,
    peerFileCount: workUnit.peerFileIndex.length,
    dependencyCount: workUnit.dependencyPaths.length,
  };
}

function stageIndexWorkUnitToMemoryFlowPlannedWorkUnit(
  workUnit: StageIndex['workUnits'][number],
): MemoryFlowPlannedWorkUnit {
  return {
    unitKey: workUnit.unitKey,
    rawFiles: workUnit.rawFiles,
    peerFileCount: 0,
    dependencyCount: 0,
  };
}

function countMemoryFlowActions(actions: MemoryAction[], target: MemoryAction['target']): number {
  return actions.filter((action) => action.target === target).length;
}

function reportIdFromCreateResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('id' in result)) {
    return undefined;
  }
  const id = (result as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function normalizeTableReference(value: string): string {
  return value
    .trim()
    .replace(/["`]/g, '')
    .replace(/[\[\]]/g, '')
    .toLowerCase();
}

function finalReferenceSegment(value: string): string {
  const parts = value.split('.').filter((part) => part.length > 0);
  return parts.at(-1) ?? value;
}

function semanticSourceMatchesTableRef(source: SemanticLayerSource, tableRef: string): boolean {
  const normalizedRef = normalizeTableReference(tableRef);
  if (!normalizedRef) {
    return false;
  }

  const refIsQualified = normalizedRef.includes('.');
  const normalizedSourceName = normalizeTableReference(source.name);
  if (normalizedSourceName === normalizedRef) {
    return true;
  }

  const table = typeof source.table === 'string' ? normalizeTableReference(source.table) : '';
  if (table && (table === normalizedRef || table.endsWith(`.${normalizedRef}`))) {
    return true;
  }
  if (!refIsQualified && table && finalReferenceSegment(table) === normalizedRef) {
    return true;
  }

  return false;
}

function rawPathsForAction(action: MemoryAction, fallbackRawPaths: string[]): string[] {
  return action.rawPaths && action.rawPaths.length > 0 ? [...new Set(action.rawPaths)] : fallbackRawPaths;
}

export class IngestBundleRunner {
  private readonly logger: KtxLogger;
  private readonly chainByConnection = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: IngestBundleRunnerDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async run(job: IngestBundleJob, ctx?: IngestJobContext): Promise<IngestBundleResult> {
    const key = job.connectionId;
    const previous = this.chainByConnection.get(key);
    if (previous) {
      this.logger.log(`[ingest-bundle] queued behind previous job for connection=${key}`);
    }
    const run = (previous ?? Promise.resolve()).catch(() => undefined).then(() => this.runInner(job, ctx));
    const chainSlot = run.finally(() => {
      if (this.chainByConnection.get(key) === chainSlot) {
        this.chainByConnection.delete(key);
      }
    });
    // Keep the chain alive but silence unhandled rejection — callers await `run` directly.
    chainSlot.catch(() => undefined);
    this.chainByConnection.set(key, chainSlot);
    try {
      const result = await run;
      ctx?.memoryFlow?.finish('done');
      return { ...result, jobId: job.jobId };
    } catch (error) {
      ctx?.memoryFlow?.finish('error', [sanitizeMemoryFlowError(error)]);
      throw error;
    }
  }

  protected stageRawFilesStage1 = stageRawFilesStage1;

  private async syncKnowledgeSlRefsFromActions(connectionId: string, actions: MemoryAction[]): Promise<void> {
    if (!this.deps.knowledgeSlRefs) {
      return;
    }

    const slTargetsBySourceName = new Map<string, Set<string>>();
    const wikiActionsByKey = new Map<string, MemoryAction>();
    for (const action of actions) {
      if (action.target === 'sl') {
        const bucket = slTargetsBySourceName.get(action.key) ?? new Set<string>();
        bucket.add(actionTargetConnectionId(action, connectionId));
        slTargetsBySourceName.set(action.key, bucket);
      }
      if (action.target === 'wiki') {
        wikiActionsByKey.set(action.key, action);
      }
    }

    for (const action of wikiActionsByKey.values()) {
      if (action.type === 'removed') {
        await this.deps.knowledgeSlRefs.syncFromWiki({
          wikiPageKey: action.key,
          wikiScope: 'GLOBAL',
          wikiScopeId: null,
          refs: [],
        });
        continue;
      }

      const page = await this.deps.wikiService.readPage('GLOBAL', null, action.key);
      const bareSources = [
        ...new Set(
          (page?.frontmatter.sl_refs ?? [])
            .map((ref) => ref.split('.')[0])
            .filter((sourceName): sourceName is string => sourceName.length > 0),
        ),
      ];
      const refs = bareSources.flatMap((sourceName) => {
        const targets = slTargetsBySourceName.get(sourceName);
        if (!targets || targets.size === 0) {
          return [{ connectionId, sourceName }];
        }
        return [...targets].sort().map((targetConnectionId) => ({ connectionId: targetConnectionId, sourceName }));
      });

      await this.deps.knowledgeSlRefs.syncFromWiki({
        wikiPageKey: action.key,
        wikiScope: 'GLOBAL',
        wikiScopeId: null,
        refs,
      });
    }
  }

  protected async materializeOverrideSnapshot(
    report: IngestReportSnapshot,
    ctx: { connectionId: string; sourceKey: string; jobId: string },
  ): Promise<string> {
    const rawRoot = rawSourcesDirForSync(ctx.connectionId, ctx.sourceKey, report.body.syncId);
    const files = await this.deps.gitService.listFilesAtHead(rawRoot);
    if (files.length === 0) {
      throw new Error(`override ingest: no raw-source files found for prior sync ${report.body.syncId}`);
    }

    const stagedDir = this.deps.storage.resolvePullDir(ctx.jobId);
    await rm(stagedDir, { recursive: true, force: true });
    await mkdir(stagedDir, { recursive: true });

    for (const file of files) {
      const relativePath = file.startsWith(`${rawRoot}/`) ? file.slice(rawRoot.length + 1) : file;
      const absoluteTarget = join(stagedDir, relativePath);
      await mkdir(dirname(absoluteTarget), { recursive: true });
      await writeFile(absoluteTarget, await this.deps.gitService.getFileAtCommit(file, 'HEAD'), 'utf-8');
    }

    return stagedDir;
  }

  protected async loadOverrideReport(job: IngestBundleJob): Promise<IngestReportSnapshot | null> {
    if (job.bundleRef.kind !== 'override') {
      return null;
    }
    const report = await this.deps.reports.findByJobId(job.bundleRef.priorJobId);
    if (!report) {
      throw new Error(`override ingest: prior report ${job.bundleRef.priorJobId} not found`);
    }
    if (report.connectionId !== job.connectionId || report.sourceKey !== job.sourceKey) {
      throw new Error(
        `override ingest: prior report ${job.bundleRef.priorJobId} belongs to ${report.connectionId}/${report.sourceKey}, not ${job.connectionId}/${job.sourceKey}`,
      );
    }
    return report;
  }

  protected async resolveStagedDir(
    ref: IngestBundleJob['bundleRef'],
    ctx: { connectionId: string; sourceKey: string; jobId: string },
  ): Promise<string> {
    if (ref.kind === 'upload') {
      return this.deps.storage.resolveUploadDir(ref.uploadId);
    }
    if (ref.kind === 'override') {
      throw new Error('override bundle refs must be materialized from the prior report snapshot');
    }
    const stagedDir = this.deps.storage.resolvePullDir(ctx.jobId);
    await mkdir(stagedDir, { recursive: true });
    const adapter = this.deps.registry.get(ctx.sourceKey);
    if (!adapter.fetch) {
      throw new Error(`source adapter '${ctx.sourceKey}' does not support scheduled_pull (no fetch() method)`);
    }
    await adapter.fetch(ref.config, stagedDir, { connectionId: ctx.connectionId, sourceKey: ctx.sourceKey });
    return stagedDir;
  }

  protected buildCommitMessage(
    job: IngestBundleJob,
    syncId: string,
    diffSummary: { added: number; modified: number; deleted: number; unchanged: number },
    failedWUs: string[],
  ): string {
    const diff = `+${diffSummary.added}/~${diffSummary.modified}/-${diffSummary.deleted}/=${diffSummary.unchanged}`;
    const failed = failedWUs.length > 0 ? `; failed WUs: ${failedWUs.join(', ')}` : '';
    return `ingest(${job.sourceKey}): ${job.jobId} syncId=${syncId} diff=${diff}${failed}`;
  }

  private async buildWikiIndex(): Promise<string> {
    const pages = await this.deps.knowledgeIndex?.listPagesForUser('system');
    if (!pages || pages.length === 0) {
      return '(empty)';
    }

    return `## Wiki Pages\n${pages.map((page) => `- ${page.page_key}: ${page.summary}`).join('\n')}`;
  }

  private async buildSlIndex(connectionIds: string[]): Promise<string> {
    const blocks = await Promise.all(
      connectionIds.map(async (connectionId) => {
        try {
          const { sources } = await this.deps.semanticLayerService.loadAllSources(connectionId);
          const names = sources.map((source) => source.name).sort((left, right) => left.localeCompare(right));
          const body = names.length > 0 ? names.join('\n') : '(no sources yet)';
          return `## ${connectionId}\n${body}`;
        } catch {
          try {
            const files = await this.deps.semanticLayerService.listFilesForConnection(connectionId);
            const names = files
              .filter((f) => !f.startsWith('_schema/'))
              .map((f) => f.replace(/\.yaml$/, ''))
              .sort((left, right) => left.localeCompare(right));
            const body = names.length > 0 ? names.join('\n') : '(no sources yet)';
            return `## ${connectionId}\n${body}`;
          } catch {
            return `## ${connectionId}\n(empty)`;
          }
        }
      }),
    );
    return blocks.join('\n\n');
  }

  private async tableRefExistsInSemanticLayer(
    semanticLayerService: SemanticLayerService,
    connectionIds: string[],
    tableRef: string,
  ): Promise<boolean> {
    for (const connectionId of connectionIds) {
      try {
        const { sources } = await semanticLayerService.loadAllSources(connectionId);
        if (sources.some((source) => semanticSourceMatchesTableRef(source, tableRef))) {
          return true;
        }
      } catch {
        // Fallback diagnostics should not fail an ingest stage if an index lookup is temporarily unavailable.
      }
    }
    return false;
  }

  private resolveContextCuratorBudget(
    bundleRef: IngestBundleJob['bundleRef'],
    stageIndex: StageIndex,
  ): { creates: number; updates: number } {
    const rawConfig =
      bundleRef.kind === 'scheduled_pull' && bundleRef.config && typeof bundleRef.config === 'object'
        ? (bundleRef.config as Record<string, unknown>)
        : {};
    const configuredCreates =
      typeof rawConfig.maxKnowledgeCreatesPerRun === 'number'
        ? rawConfig.maxKnowledgeCreatesPerRun
        : NOTION_DEFAULT_MAX_KNOWLEDGE_CREATES_PER_RUN;
    const configuredUpdates =
      typeof rawConfig.maxKnowledgeUpdatesPerRun === 'number' ? rawConfig.maxKnowledgeUpdatesPerRun : 20;
    const wikiActions = stageIndex.workUnits.flatMap((wu) => wu.actions).filter((action) => action.target === 'wiki');
    const usedCreates = wikiActions.filter((action) => action.type === 'created').length;
    const usedUpdates = wikiActions.filter((action) => action.type === 'updated').length;

    return {
      creates: Math.max(0, configuredCreates - usedCreates),
      updates: Math.max(0, configuredUpdates - usedUpdates),
    };
  }

  private buildFailedWorkUnitOutcome(wu: WorkUnit, error: unknown): WorkUnitOutcome {
    return {
      unitKey: wu.unitKey,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      preSha: '',
      postSha: '',
      actions: [],
      touchedSlSources: [],
      slDisallowed: wu.slDisallowed,
      slDisallowedReason: wu.slDisallowedReason,
    };
  }

  private formatWorkUnitFailure(outcome: WorkUnitOutcome): string {
    return `WorkUnit ${outcome.unitKey} failed: ${outcome.reason ?? 'unknown failure'}`;
  }

  private filterWorkUnitsForTriage(
    workUnits: WorkUnit[],
    triageResult: { enabled: boolean; fullRawPaths: Set<string> } | null,
  ): WorkUnit[] {
    if (!triageResult?.enabled) {
      return workUnits;
    }
    return workUnits.filter((wu) => wu.rawFiles.some((rawPath) => triageResult.fullRawPaths.has(rawPath)));
  }

  protected async runInner(job: IngestBundleJob, ctx?: IngestJobContext): Promise<Omit<IngestBundleResult, 'jobId'>> {
    const syncId = buildSyncId(new Date(), job.jobId);
    const memoryFlow = ctx?.memoryFlow;
    const baseSha = await this.deps.lockingService.withLock('config:repo', () => this.deps.gitService.revParseHead());
    if (!baseSha) {
      throw new Error('ingest-bundle: config repo has no HEAD');
    }
    const transcriptDir = this.deps.storage.resolveTranscriptDir(job.jobId);
    const transcriptSummaries = new Map<string, MutableToolTranscriptSummary>();
    const recordedToolErrorKeys = new Set<string>();
    const transcriptErrorKey = (
      entry: Pick<ToolCallLogEntry, 'wuKey' | 'toolName' | 'toolCallId' | 'error'>,
    ): string | null => (entry.error && entry.toolCallId ? `${entry.wuKey}:${entry.toolName}:${entry.toolCallId}` : null);
    const recordTranscriptEntry =
      (path: string) =>
      (entry: ToolCallLogEntry): void => {
        const errorKey = transcriptErrorKey(entry);
        if (errorKey) {
          recordedToolErrorKeys.add(errorKey);
        }
        const current =
          transcriptSummaries.get(entry.wuKey) ?? createMutableToolTranscriptSummary(entry.wuKey, path);
        recordToolTranscriptEntry(current, entry);
        transcriptSummaries.set(entry.wuKey, current);
      };
    const recordSdkToolFailure =
      (path: string, unitKey: string) =>
      (failure: RunLoopToolFailure): void => {
        const entry: ToolCallLogEntry = {
          ts: new Date().toISOString(),
          wuKey: unitKey,
          ...(failure.toolCallId ? { toolCallId: failure.toolCallId } : {}),
          toolName: failure.toolName,
          durationMs: failure.durationMs ?? 0,
          input: failure.input,
          error: { message: failure.error },
        };
        const errorKey = transcriptErrorKey(entry);
        if (errorKey && recordedToolErrorKeys.has(errorKey)) {
          return;
        }
        recordTranscriptEntry(path)(entry);
      };
    const overrideReport = await this.loadOverrideReport(job);

    const stage1 = ctx?.startPhase(0.08);
    await stage1?.updateProgress(0.0, 'Fetching source files');

    const adapter = this.deps.registry.get(job.sourceKey);
    const stagedDir = overrideReport
      ? await this.materializeOverrideSnapshot(overrideReport, {
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          jobId: job.jobId,
        })
      : await this.resolveStagedDir(job.bundleRef, {
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          jobId: job.jobId,
        });
    const fetchReport = adapter.readFetchReport ? await adapter.readFetchReport(stagedDir) : null;

    const scopeDescriptor = adapter.describeScope ? await adapter.describeScope(stagedDir) : null;

    const sessionWorktree = await this.deps.lockingService.withLock('config:repo', () =>
      this.deps.sessionWorktreeService.create(job.jobId, baseSha),
    );
    let cleanupOutcome: 'success' | 'crash' = 'crash';

    try {
      const { currentHashes, rawDirInWorktree } = await this.stageRawFilesStage1({
        stagedDir,
        worktreeRoot: sessionWorktree.workdir,
        connectionId: job.connectionId,
        sourceKey: job.sourceKey,
        syncId,
      });
      memoryFlow?.update({
        connectionId: job.connectionId,
        adapter: job.sourceKey,
        sourceDir: stagedDir,
        syncId,
      });
      memoryFlow?.emit({
        type: 'source_acquired',
        adapter: job.sourceKey,
        trigger: job.trigger,
        fileCount: currentHashes.size,
      });
      memoryFlow?.emit({ type: 'scope_detected', fingerprint: scopeDescriptor?.fingerprint ?? null });
      memoryFlow?.emit({ type: 'raw_snapshot_written', syncId, rawFileCount: currentHashes.size });

      await sessionWorktree.git.commitFiles(
        [rawDirInWorktree],
        `ingest(${job.sourceKey}): stage raw files syncId=${syncId}`,
        this.deps.storage.systemGitAuthor.name,
        this.deps.storage.systemGitAuthor.email,
      );

      await stage1?.updateProgress(0.5, 'Checking what changed');

      const diffSet = await this.deps.diffSetService.compute(
        job.connectionId,
        job.sourceKey,
        currentHashes,
        scopeDescriptor ? scopeDescriptor.isPathInScope.bind(scopeDescriptor) : undefined,
      );
      const diffSummary = {
        added: diffSet.added.length,
        modified: diffSet.modified.length,
        deleted: diffSet.deleted.length,
        unchanged: diffSet.unchanged.length,
      };
      memoryFlow?.emit({ type: 'diff_computed', ...diffSummary });

      const runRow = await this.deps.runs.create({
        jobId: job.jobId,
        connectionId: job.connectionId,
        sourceKey: job.sourceKey,
        syncId,
        trigger: job.trigger,
        scopeFingerprint: scopeDescriptor?.fingerprint ?? null,
      });
      memoryFlow?.update({ runId: runRow.id });
      const ingestToolMetadata = {
        runId: runRow.id,
        jobId: job.jobId,
        syncId,
        sourceKey: job.sourceKey,
      };

      await stage1?.updateProgress(
        1.0,
        `${diffSet.added.length} new, ${diffSet.modified.length} changed, ${diffSet.deleted.length} removed`,
      );

      const detected = await adapter.detect(stagedDir);
      if (!detected) {
        await this.deps.runs.markFailed(runRow.id);
        throw new Error(`source adapter '${job.sourceKey}' did not recognize staged dir`);
      }

      let contextReport: ContextEvidenceIndexSummary | null = null;
      if (adapter.evidenceIndexing === 'documents' && this.deps.contextEvidenceIndex) {
        contextReport = await this.deps.contextEvidenceIndex.indexStagedDir({
          stagedDir,
          runId: runRow.id,
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          diffSet,
          currentHashes,
        });
      }

      const stage2 = ctx?.startPhase(0.04);
      await stage2?.updateProgress(0.0, 'Planning updates');
      let workUnits: WorkUnit[] = [];
      let eviction: EvictionUnit | undefined;
      let unresolvedCards: UnresolvedCardInfo[] | undefined;
      let sourceContextReport: { capped?: boolean; warnings?: string[] } | undefined;
      let parseArtifacts: unknown;
      let postProcessorOutcome: IngestReportPostProcessorOutcome | undefined;
      let wikiSlRefRepairResult: WikiSlRefRepairResult | null = null;
      let reconcileNotes: string[] = [];
      let triageResult: PageTriageRunResult | null = null;
      if (overrideReport) {
        eviction =
          overrideReport.body.evictionInputs.length > 0
            ? { deletedRawPaths: overrideReport.body.evictionInputs }
            : undefined;
        unresolvedCards = overrideReport.body.unresolvedCards;
        await stage2?.updateProgress(1.0, `Loaded prior report ${overrideReport.jobId} for override reconciliation`);
      } else {
        const chunk = await adapter.chunk(stagedDir, diffSet);
        workUnits = chunk.workUnits;
        eviction = chunk.eviction;
        unresolvedCards = chunk.unresolvedCards;
        sourceContextReport = chunk.contextReport;
        parseArtifacts = chunk.parseArtifacts;
        reconcileNotes = chunk.reconcileNotes ?? [];
        triageResult =
          contextReport && adapter.triageSupported && this.deps.pageTriage
            ? await this.deps.pageTriage.triageRun({
                stagedDir,
                runId: runRow.id,
                connectionId: job.connectionId,
                sourceKey: job.sourceKey,
                syncId,
                jobId: job.jobId,
                diffSet,
                adapter,
              })
            : null;
        workUnits = this.filterWorkUnitsForTriage(workUnits, triageResult);
        if (adapter.clusterWorkUnits && workUnits.length > 0) {
          workUnits = await adapter.clusterWorkUnits({
            workUnits,
            stagedDir,
            embedding: this.deps.embedding,
          });
        }
        await stage2?.updateProgress(1.0, `Planned ${workUnits.length} update${workUnits.length === 1 ? '' : 's'}`);
      }

      const targetConnectionIds = new Set<string>([job.connectionId]);
      if (!overrideReport && adapter.listTargetConnectionIds) {
        for (const connectionId of await adapter.listTargetConnectionIds(stagedDir)) {
          targetConnectionIds.add(connectionId);
        }
      }
      if (overrideReport) {
        for (const wu of overrideReport.body.workUnits) {
          for (const action of wu.actions) {
            if (action.target === 'sl' && action.targetConnectionId) {
              targetConnectionIds.add(action.targetConnectionId);
            }
          }
          for (const touched of wu.touchedSlSources) {
            targetConnectionIds.add(touched.connectionId);
          }
        }
      }
      const slConnectionIds = [...targetConnectionIds].sort();

      // Build shared per-job context.
      const [wikiIndex, slIndex] = await Promise.all([this.buildWikiIndex(), this.buildSlIndex(slConnectionIds)]);

      const baseFraming = await this.deps.promptService.loadPrompt('memory_agent_bundle_ingest_work_unit');
      const wuSkillNames = Array.from(
        new Set<string>([...adapter.skillNames, 'ingest_triage', 'sl_capture', 'wiki_capture']),
      );
      const wuSkills = await this.deps.skillsRegistry.listSkills(wuSkillNames, 'memory_agent');
      const skillsPrompt = this.deps.skillsRegistry.buildSkillsPrompt(wuSkills, 'memory_agent');
      const canonicalPins = await this.deps.canonicalPins.listPins(slConnectionIds);

      const workUnitOutcomes: WorkUnitOutcome[] = [];
      const failedWorkUnits: string[] = [];
      const stageIndex: StageIndex = overrideReport
        ? buildStageIndexFromReportBody(job.jobId, overrideReport.connectionId, overrideReport.body)
        : {
            jobId: job.jobId,
            connectionId: job.connectionId,
            workUnits: [],
            conflictsResolved: [],
            evictionsApplied: [],
            unmappedFallbacks: [],
            artifactResolutions: [],
          };
      const memoryFlowPlannedWorkUnits = overrideReport
        ? stageIndex.workUnits.map(stageIndexWorkUnitToMemoryFlowPlannedWorkUnit)
        : workUnits.map(workUnitToMemoryFlowPlannedWorkUnit);
      memoryFlow?.update({ plannedWorkUnits: memoryFlowPlannedWorkUnits });
      memoryFlow?.emit({
        type: 'chunks_planned',
        chunkCount: memoryFlowPlannedWorkUnits.length,
        workUnitCount: memoryFlowPlannedWorkUnits.length,
        evictionCount: eviction?.deletedRawPaths.length ?? 0,
      });

      const stage3 = ctx?.startPhase(0.6);
      await stage3?.updateProgress(0.0, `Processing ${workUnits.length} update${workUnits.length === 1 ? '' : 's'}`);
      this.logger.log(`[ingest-bundle] job=${job.jobId} tool-call transcripts: ${transcriptDir}/`);

      if (!overrideReport) {
        const workUnitSettings = {
          maxConcurrency: this.deps.settings.workUnitMaxConcurrency ?? 1,
          stepBudget: this.deps.settings.workUnitStepBudget ?? 40,
          failureMode: this.deps.settings.workUnitFailureMode ?? 'continue',
        };
        const limitWorkUnit = pLimit(workUnitSettings.maxConcurrency);
        const workUnitOutcomesByIndex: WorkUnitOutcome[] = [];
        let completedWorkUnits = 0;
        let abortRequested = false;

        const runSingleWorkUnit = async (wu: WorkUnit): Promise<WorkUnitOutcome> => {
          const session: CaptureSession = {
            userId: 'system',
            chatId: wu.unitKey,
            userMessage: `ingest(${job.sourceKey}) WU=${wu.unitKey}`,
            connectionId: job.connectionId,
            userScopedEnabled: false,
            forceGlobalScope: true,
            touchedSlSources: createTouchedSlSources(),
            preHead: sessionWorktree.baseSha,
          };
          const sessionActions: MemoryAction[] = [];

          const scopedWikiService = this.deps.wikiService.forWorktree(sessionWorktree.workdir);
          const scopedSemanticLayerService = this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir);

          const toolSession: ToolSession = {
            connectionId: job.connectionId,
            isWorktreeScoped: true,
            preHead: sessionWorktree.baseSha,
            touchedSlSources: session.touchedSlSources,
            actions: sessionActions,
            allowedRawPaths: new Set(wu.rawFiles),
            allowedConnectionNames: new Set(slConnectionIds),
            semanticLayerService: scopedSemanticLayerService,
            wikiService: scopedWikiService,
            configService: sessionWorktree.config,
            gitService: sessionWorktree.git,
            ingest: ingestToolMetadata,
          };

          const slValidationDeps: SlValidationDeps = {
            semanticLayerService: scopedSemanticLayerService,
            connections: this.deps.connections,
            configService: sessionWorktree.config,
            gitService: sessionWorktree.git,
            slSourcesRepository: this.deps.slSourcesRepository,
            probeRowCount: this.deps.settings.probeRowCount,
          };

          const wuToolset = this.deps.toolsetFactory.createIngestWuToolset(toolSession, {
            includeContextEvidenceTools: adapter.evidenceIndexing === 'documents' && !!contextReport,
          });
          const wuToolContext: ToolContext = {
            sourceId: 'ingest',
            messageId: `${job.jobId}-wu-${wu.unitKey}`,
            userId: 'system',
            connectionId: job.connectionId,
            ingest: ingestToolMetadata,
            session: toolSession,
          };

          const skillsLoadedPerWu: string[] = [];
          const loadSkillTool: AgentToolSet = {
            load_skill: createAgentTool({
              name: 'load_skill',
              description:
                'Load a skill to get specialized instructions. Call this when a skill listed in the system prompt matches the current task.',
              inputSchema: z.object({ name: z.string() }),
              execute: async ({ name }) => {
                const skill = await this.deps.skillsRegistry.getSkill(name, 'memory_agent');
                if (!skill) {
                  const available =
                    (await this.deps.skillsRegistry.listSkills('memory_agent')).map((s) => s.name).join(', ') ||
                    '(none)';
                  return `Skill "${name}" not available. Available: ${available}`;
                }
                const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
                if (!skillsLoadedPerWu.includes(skill.name)) {
                  skillsLoadedPerWu.push(skill.name);
                }
                return {
                  name: skill.name,
                  skillDirectory: skill.path,
                  content: this.deps.skillsRegistry.stripFrontmatter(body),
                };
              },
            }),
          };

          const priorProvenance = await this.deps.provenance.findLatestArtifactsForRawPaths(
            job.connectionId,
            job.sourceKey,
            wu.rawFiles,
          );
          const wuEmitUnmappedFallbackTool = {
            emit_unmapped_fallback: createEmitUnmappedFallbackTool({
              stageIndex,
              allowedPaths: new Set(wu.rawFiles),
              tableRefExists: (tableRef) =>
                this.tableRefExistsInSemanticLayer(scopedSemanticLayerService, slConnectionIds, tableRef),
            }),
          };

          const systemPrompt = buildWuSystemPrompt({
            baseFraming,
            skillsPrompt,
            syncId,
            sourceKey: job.sourceKey,
            canonicalPins,
          });

          memoryFlow?.emit({
            type: 'work_unit_started',
            unitKey: wu.unitKey,
            skills: wuSkillNames,
            stepBudget: workUnitSettings.stepBudget,
          });
          return executeWorkUnit(
            {
              sessionWorktreeGit: sessionWorktree.git,
              agentRunner: this.deps.agentRunner,
              validateTouchedSources: (touched) =>
                validateWuTouchedSources({ ...slValidationDeps, slValidator: this.deps.slValidator }, touched),
              resetHardTo: (targetSha) => sessionWorktree.git.resetHardTo(targetSha),
              buildSystemPrompt: () => systemPrompt,
              buildUserPrompt: (wuInner) => buildWuUserPrompt({ wu: wuInner, wikiIndex, slIndex, priorProvenance }),
              buildToolSet: (wuInner) =>
                wrapToolsWithLogger(
                  buildWuToolSet({
                    sourceKey: job.sourceKey,
                    stagedDir,
                    wu: wuInner,
                    loadSkillTool,
                    emitUnmappedFallbackTool: wuEmitUnmappedFallbackTool,
                    toolsetTools: wuToolset.toAgentTools(wuToolContext),
                  }),
                  join(transcriptDir, `${wuInner.unitKey}.jsonl`),
                  wuInner.unitKey,
                  { onEntry: recordTranscriptEntry(join(transcriptDir, `${wuInner.unitKey}.jsonl`)) },
                ),
              captureSession: session,
              sessionActions,
              modelRole: 'candidateExtraction',
              stepBudget: workUnitSettings.stepBudget,
              sourceKey: job.sourceKey,
              connectionId: job.connectionId,
              jobId: job.jobId,
              onToolFailure: (unitKey, failure) =>
                recordSdkToolFailure(join(transcriptDir, `${unitKey}.jsonl`), unitKey)(failure),
              toolFailureCount: (unitKey) => transcriptSummaries.get(unitKey)?.fatalErrorCount ?? 0,
              onStepFinish: ({ stepIndex, stepBudget }) => {
                memoryFlow?.emit({ type: 'work_unit_step', unitKey: wu.unitKey, stepIndex, stepBudget });
              },
            },
            wu,
          );
        };

        if (workUnits.length === 0) {
          await stage3?.updateProgress(1.0, '0 of 0 work units complete');
        }

        try {
          await Promise.all(
            workUnits.map((wu, index) =>
              limitWorkUnit(async () => {
                if (abortRequested) {
                  return;
                }

                let outcome: WorkUnitOutcome;
                try {
                  outcome = await runSingleWorkUnit(wu);
                } catch (error) {
                  outcome = this.buildFailedWorkUnitOutcome(wu, error);
                }

                workUnitOutcomesByIndex[index] = outcome;
                for (const action of outcome.actions) {
                  memoryFlow?.emit({
                    type: 'candidate_action',
                    unitKey: outcome.unitKey,
                    target: action.target,
                    action: action.type,
                    key: action.key,
                  });
                }
                memoryFlow?.emit({
                  type: 'work_unit_finished',
                  unitKey: outcome.unitKey,
                  status: outcome.status,
                  ...(outcome.reason ? { reason: outcome.reason } : {}),
                });
                completedWorkUnits += 1;
                await stage3?.updateProgress(
                  completedWorkUnits / workUnits.length,
                  `${completedWorkUnits} of ${workUnits.length} work units complete`,
                );

                if (outcome.status === 'failed') {
                  this.logger.warn(`[ingest-bundle] WU=${outcome.unitKey} failed: ${outcome.reason}`);
                  if (workUnitSettings.failureMode === 'abort') {
                    abortRequested = true;
                    throw new Error(this.formatWorkUnitFailure(outcome));
                  }
                }
              }),
            ),
          );
        } catch (error) {
          await this.deps.runs.markFailed(runRow.id);
          throw error;
        }

        workUnitOutcomes.push(
          ...workUnitOutcomesByIndex.filter((outcome): outcome is WorkUnitOutcome => Boolean(outcome)),
        );
        failedWorkUnits.push(
          ...workUnitOutcomes.filter((outcome) => outcome.status === 'failed').map((outcome) => outcome.unitKey),
        );

        // Complete the typed Stage Index from the outcomes once, and use it for
        // Stage 4, provenance writes (Phase G), and the report body (Phase F3).
        stageIndex.workUnits = workUnitOutcomes.map((o) => ({
          unitKey: o.unitKey,
          rawFiles: workUnits.find((w) => w.unitKey === o.unitKey)?.rawFiles ?? [],
          status: o.status,
          reason: o.reason,
          actions: o.actions,
          touchedSlSources: o.touchedSlSources,
          slDisallowed: o.slDisallowed,
          slDisallowedReason: o.slDisallowedReason,
        }));
      }
      const carryForwardResult =
        contextReport && this.deps.contextCandidateCarryforward
          ? await this.deps.contextCandidateCarryforward.carryForward({
              runId: runRow.id,
              connectionId: job.connectionId,
              sourceKey: job.sourceKey,
            })
          : null;
      const dedupResult =
        contextReport && this.deps.candidateDedup ? await this.deps.candidateDedup.deduplicateRun(runRow.id) : null;

      // Stage 4 — reconciliation. Shares scoped wiki/SL with a fresh CaptureSession
      // so reconciliation writes land in the same worktree Stage 3 used.
      const reconcileSession: CaptureSession = {
        userId: 'system',
        chatId: `${job.jobId}-reconcile`,
        userMessage: `reconcile(${job.sourceKey})`,
        connectionId: job.connectionId,
        userScopedEnabled: false,
        forceGlobalScope: true,
        touchedSlSources: createTouchedSlSources(),
        preHead: await sessionWorktree.git.revParseHead(),
      };
      const reconcileActions: MemoryAction[] = [];
      const rcScopedWiki = this.deps.wikiService.forWorktree(sessionWorktree.workdir);
      const rcScopedSl = this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir);
      const reconciliationAllowedRawPaths = new Set<string>([
        ...currentHashes.keys(),
        ...(eviction?.deletedRawPaths ?? []),
      ]);

      const rcToolSession: ToolSession = {
        connectionId: job.connectionId,
        isWorktreeScoped: true,
        preHead: reconcileSession.preHead,
        touchedSlSources: reconcileSession.touchedSlSources,
        actions: reconcileActions,
        allowedRawPaths: reconciliationAllowedRawPaths,
        allowedConnectionNames: new Set(slConnectionIds),
        semanticLayerService: rcScopedSl,
        wikiService: rcScopedWiki,
        configService: sessionWorktree.config,
        gitService: sessionWorktree.git,
        ingest: ingestToolMetadata,
        evictionDecisions: [],
      };

      const rcToolset = this.deps.toolsetFactory.createIngestWuToolset(rcToolSession, {
        includeContextEvidenceTools: adapter.evidenceIndexing === 'documents' && !!contextReport,
      });
      const rcToolContext: ToolContext = {
        sourceId: 'ingest',
        messageId: `${job.jobId}-reconcile`,
        userId: 'system',
        connectionId: job.connectionId,
        ingest: ingestToolMetadata,
        session: rcToolSession,
      };
      const rcLoadSkill: AgentToolSet = {
        load_skill: createAgentTool({
          name: 'load_skill',
          description: 'Load a skill.',
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => {
            const skill = await this.deps.skillsRegistry.getSkill(name, 'memory_agent');
            if (!skill) {
              return `Skill "${name}" not found`;
            }
            const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
            return { name: skill.name, content: this.deps.skillsRegistry.stripFrontmatter(body) };
          },
        }),
      };
      const allStagedPaths = new Set<string>([...currentHashes.keys()]);
      const rcRawSpanTool = { read_raw_span: createReadRawSpanTool({ stagedDir, allowedPaths: allStagedPaths }) };
      const rcStageListTool = { stage_list: createStageListTool({ stageIndex }) };
      const rcStageDiffTool = { stage_diff: createStageDiffTool({ stageIndex }) };
      const rcEvictionListTool = {
        eviction_list: createEvictionListTool({
          provenance: this.deps.provenance,
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          deletedRawPaths: eviction?.deletedRawPaths ?? [],
        }),
      };
      const rcEmitConflictResolutionTool = {
        emit_conflict_resolution: createEmitConflictResolutionTool({ stageIndex }),
      };
      const rcEmitEvictionDecisionTool = {
        emit_eviction_decision: createEmitEvictionDecisionTool({
          stageIndex,
          deletedRawPaths: eviction?.deletedRawPaths ?? [],
        }),
      };
      const rcEmitArtifactResolutionTool = {
        emit_artifact_resolution: createEmitArtifactResolutionTool({
          stageIndex,
          allowedPaths: allStagedPaths,
        }),
      };
      const rcEmitUnmappedFallbackTool = {
        emit_unmapped_fallback: createEmitUnmappedFallbackTool({
          stageIndex,
          allowedPaths: allStagedPaths,
          tableRefExists: (tableRef) => this.tableRefExistsInSemanticLayer(rcScopedSl, slConnectionIds, tableRef),
        }),
      };

      const reconcileBaseFraming = await this.deps.promptService.loadPrompt('memory_agent_bundle_ingest_reconcile');
      const reconcileSkills = await this.deps.skillsRegistry.listSkills(
        Array.from(
          new Set(['ingest_triage', 'sl_capture', 'wiki_capture', ...(adapter.reconcileSkillNames ?? [])]),
        ),
        'memory_agent',
      );
      const reconcileSkillsPrompt = this.deps.skillsRegistry.buildSkillsPrompt(reconcileSkills, 'memory_agent');
      const relevantCanonicalPins = selectRelevantCanonicalPins(stageIndex, canonicalPins);

      const stage4 = ctx?.startPhase(0.16);
      const hasCandidateReconcileWork = (dedupResult?.representatives.length ?? 0) > 0;
      const hasReconcileWork =
        stageIndex.workUnits.some((wu) => wu.actions.length > 0) ||
        (eviction?.deletedRawPaths.length ?? 0) > 0 ||
        hasCandidateReconcileWork;
      if (hasReconcileWork || overrideReport) {
        await stage4?.updateProgress(0.0, 'Reconciling results');
      }

      let curatorReport = null;
      let curatorWarnings: string[] = [];
      let reconcileOutcome: Awaited<ReturnType<typeof runReconciliationStage4>>;

      if (contextReport && this.deps.curatorPagination) {
        const curatorOutcome = await this.deps.curatorPagination.reconcile({
          runId: runRow.id,
          sourceKey: job.sourceKey,
          jobId: job.jobId,
          stageIndex,
          evictionUnit: eviction,
          representatives: dedupResult?.representatives ?? [],
          initialBudget: this.resolveContextCuratorBudget(job.bundleRef, stageIndex),
          modelRole: 'curator',
          buildSystemPrompt: () =>
            buildReconcileSystemPrompt({
              baseFraming: reconcileBaseFraming,
              skillsPrompt: reconcileSkillsPrompt,
              syncId,
              sourceKey: job.sourceKey,
              canonicalPins: relevantCanonicalPins,
            }),
          buildUserPrompt: ({ summary, items, runState }) =>
            buildReconcileUserPrompt(stageIndex, eviction, { summary, items }, reconcileNotes, runState),
          buildToolSet: (_passNumber) =>
            wrapToolsWithLogger(
              buildReconcileToolSet({
                loadSkillTool: rcLoadSkill,
                stageListTool: rcStageListTool,
                stageDiffTool: rcStageDiffTool,
                evictionListTool: rcEvictionListTool,
                emitConflictResolutionTool: rcEmitConflictResolutionTool,
                emitEvictionDecisionTool: rcEmitEvictionDecisionTool,
                emitArtifactResolutionTool: rcEmitArtifactResolutionTool,
                emitUnmappedFallbackTool: rcEmitUnmappedFallbackTool,
                readRawSpanTool: rcRawSpanTool,
                toolsetTools: rcToolset.toAgentTools(rcToolContext),
              }),
              join(transcriptDir, 'reconcile.jsonl'),
              'reconcile',
              { onEntry: recordTranscriptEntry(join(transcriptDir, 'reconcile.jsonl')) },
            ),
          getReconciliationActions: () => reconcileActions,
          onStepFinish: stage4
            ? ({ passNumber, stepIndex, stepBudget }) => {
                void stage4.updateProgress(
                  stepIndex / stepBudget,
                  `Reconciling results · pass ${passNumber} step ${stepIndex}`,
                );
              }
            : undefined,
        });
        curatorReport = curatorOutcome.report;
        curatorWarnings = curatorOutcome.warnings;
        reconcileOutcome = {
          skipped: curatorOutcome.skipped,
          stopReason: curatorOutcome.stopReason,
          error: curatorOutcome.error,
        };
      } else {
        reconcileOutcome = await runReconciliationStage4({
          stageIndex,
          evictionUnit: eviction,
          agentRunner: this.deps.agentRunner,
          buildSystemPrompt: () =>
            buildReconcileSystemPrompt({
              baseFraming: reconcileBaseFraming,
              skillsPrompt: reconcileSkillsPrompt,
              syncId,
              sourceKey: job.sourceKey,
              canonicalPins: relevantCanonicalPins,
            }),
          buildUserPrompt: (idx, ev) => buildReconcileUserPrompt(idx, ev, undefined, reconcileNotes),
          buildToolSet: () =>
            wrapToolsWithLogger(
              buildReconcileToolSet({
                loadSkillTool: rcLoadSkill,
                stageListTool: rcStageListTool,
                stageDiffTool: rcStageDiffTool,
                evictionListTool: rcEvictionListTool,
                emitConflictResolutionTool: rcEmitConflictResolutionTool,
                emitEvictionDecisionTool: rcEmitEvictionDecisionTool,
                emitArtifactResolutionTool: rcEmitArtifactResolutionTool,
                emitUnmappedFallbackTool: rcEmitUnmappedFallbackTool,
                readRawSpanTool: rcRawSpanTool,
                toolsetTools: rcToolset.toAgentTools(rcToolContext),
              }),
              join(transcriptDir, 'reconcile.jsonl'),
              'reconcile',
              { onEntry: recordTranscriptEntry(join(transcriptDir, 'reconcile.jsonl')) },
            ),
          modelRole: 'reconcile',
          stepBudget: 60,
          sourceKey: job.sourceKey,
          jobId: job.jobId,
          force: !!overrideReport,
          onStepFinish: stage4
            ? ({ stepIndex, stepBudget }) => {
                void stage4.updateProgress(stepIndex / stepBudget, `Reconciling results · step ${stepIndex}`);
              }
            : undefined,
        });
      }

      const candidateSummaryAfterReconcile =
        contextReport && this.deps.contextEvidenceCandidates
          ? await this.deps.contextEvidenceCandidates.getCandidateSummary(runRow.id)
          : null;
      memoryFlow?.emit({
        type: 'reconciliation_finished',
        conflictCount: stageIndex.conflictsResolved.length,
        fallbackCount: stageIndex.unmappedFallbacks.length,
      });

      await stage4?.updateProgress(1.0, reconcileOutcome.skipped ? 'No reconciliation needed' : 'Reconciled');

      const postProcessor = this.deps.postProcessors?.[job.sourceKey];
      if (postProcessor) {
        const stagePostProcessor = ctx?.startPhase(0.04);
        await stagePostProcessor?.updateProgress(0.0, 'Running deterministic imports');
        try {
          const result = await postProcessor.run({
            connectionId: job.connectionId,
            sourceKey: job.sourceKey,
            syncId,
            jobId: job.jobId,
            runId: runRow.id,
            workdir: sessionWorktree.workdir,
            parseArtifacts,
          });
          postProcessorOutcome = {
            sourceKey: job.sourceKey,
            status: result.errors.length > 0 && result.touchedSources.length === 0 ? 'failed' : 'success',
            result: result.result,
            errors: result.errors,
            warnings: result.warnings,
            touchedSources: result.touchedSources,
          };
          await stagePostProcessor?.updateProgress(1.0, 'Deterministic imports complete');
        } catch (error) {
          postProcessorOutcome = {
            sourceKey: job.sourceKey,
            status: 'failed',
            errors: [error instanceof Error ? error.message : String(error)],
            warnings: [],
            touchedSources: [],
          };
          await this.deps.runs.markFailed(runRow.id);
          throw error;
        }
      }

      const repairConnectionIds = [
        ...new Set([
          ...slConnectionIds,
          ...(postProcessorOutcome?.touchedSources ?? []).map((source) => source.connectionId),
        ]),
      ].sort();
      wikiSlRefRepairResult = await repairWikiSlRefs({
        wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
        semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
        configService: sessionWorktree.config,
        connectionIds: repairConnectionIds,
      });

      // Stage 6 — squash commit
      const stage6 = ctx?.startPhase(0.04);
      await stage6?.updateProgress(0.0, 'Saving changes');
      try {
        await sessionWorktree.git.assertWorktreeClean();
      } catch (error) {
        await this.deps.runs.markFailed(runRow.id);
        throw error;
      }
      const commitMessage = this.buildCommitMessage(job, syncId, diffSummary, failedWorkUnits);
      const squashResult = await this.deps.lockingService.withLock('config:repo', async () => {
        const preSquashSha = await this.deps.gitService.revParseHead();
        const merge = await this.deps.gitService.squashMergeIntoMain(
          sessionWorktree.branch,
          this.deps.storage.systemGitAuthor.name,
          this.deps.storage.systemGitAuthor.email,
          commitMessage,
        );
        return { preSquashSha, merge };
      });
      const mergeResult = squashResult.merge;
      if (!mergeResult.ok) {
        await this.deps.runs.markFailed(runRow.id);
        throw new Error(`squash merge conflict: ${mergeResult.conflictPaths.join(', ')}`);
      }
      const commitSha = mergeResult.touchedPaths.length === 0 ? null : mergeResult.squashSha;
      const memoryFlowSavedActions = stageIndex.workUnits.flatMap((wu) => wu.actions).concat(reconcileActions);
      const postProcessorMemoryCounts = postProcessorSavedMemoryCounts(postProcessorOutcome);
      memoryFlow?.emit({
        type: 'saved',
        commitSha,
        wikiCount: countMemoryFlowActions(memoryFlowSavedActions, 'wiki') + postProcessorMemoryCounts.wikiCount,
        slCount: countMemoryFlowActions(memoryFlowSavedActions, 'sl') + postProcessorMemoryCounts.slCount,
      });
      await stage6?.updateProgress(1.0, commitSha ? `Saved changes (${commitSha.slice(0, 8)})` : 'No changes to save');

      // Sync the shared `knowledge` index from the squashed diff in a single
      // transaction. If this throws, the run fails and no partial index state
      // survives (thanks to the transactional upsert in applyDiffTransactional).
      if (commitSha) {
        // Multi-file squash → omit path so the handler diffs the whole commit
        // (a comma-joined pathspec would match nothing and the job would no-op).
        const pathFilter = mergeResult.touchedPaths.length === 1 ? mergeResult.touchedPaths[0] : '';
        await this.deps.commitMessages.enqueueForExternalCommit({ commitHash: commitSha }, commitMessage, pathFilter);
        await this.deps.wikiService.syncFromCommit(squashResult.preSquashSha, commitSha, runRow.id);
        await this.syncKnowledgeSlRefsFromActions(job.connectionId, memoryFlowSavedActions);
        const touchedConnections = [
          ...new Set(
            memoryFlowSavedActions
              .filter((action) => action.target === 'sl')
              .map((action) => actionTargetConnectionId(action, job.connectionId))
              .concat((postProcessorOutcome?.touchedSources ?? []).map((source) => source.connectionId)),
          ),
        ].sort();
        for (const connectionId of touchedConnections) {
          try {
            const { sources: allSources } = await this.deps.semanticLayerService.loadAllSources(connectionId);
            await this.deps.slSearchService.indexSources(connectionId, allSources);
          } catch (err) {
            this.logger.warn(
              `[ingest-bundle] post-squash SL reindex failed for connection=${connectionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      const stage5 = ctx?.startPhase(0.04);
      await stage5?.updateProgress(0.0, 'Recording history');

      // Provenance rows: per-artifact when the WU emitted actions, plus a `skipped`
      // fallback for raw files that produced nothing so the next DiffSet still sees
      // them.
      const provenanceRows: Parameters<typeof this.deps.provenance.insertMany>[0] = [];
      const actionToType = (a: MemoryAction): 'source_created' | 'measure_added' | 'wiki_written' => {
        if (a.target === 'wiki') {
          return 'wiki_written';
        }
        // SL action: 'created' → source_created; 'updated' → measure_added (coarse-grained;
        // action.detail preserves the finer distinction for the report body).
        return a.type === 'created' ? 'source_created' : 'measure_added';
      };
      const producedPaths = new Set<string>();
      const pushActionProvenance = (rawPath: string, action: MemoryAction): void => {
        const hash = currentHashes.get(rawPath) ?? 'unknown';
        provenanceRows.push({
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          rawPath,
          rawContentHash: hash,
          artifactKind: action.target,
          artifactKey: action.key,
          targetConnectionId: action.target === 'sl' ? actionTargetConnectionId(action, job.connectionId) : null,
          artifactContentHash: null,
          actionType: actionToType(action),
        });
        producedPaths.add(rawPath);
      };
      for (const wu of stageIndex.workUnits) {
        for (const action of wu.actions) {
          for (const rawPath of rawPathsForAction(action, wu.rawFiles)) {
            pushActionProvenance(rawPath, action);
          }
        }
      }
      for (const action of reconcileActions) {
        for (const rawPath of action.rawPaths ?? []) {
          pushActionProvenance(rawPath, action);
        }
      }
      for (const resolution of stageIndex.artifactResolutions ?? []) {
        const hash = currentHashes.get(resolution.rawPath) ?? 'unknown';
        provenanceRows.push({
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          rawPath: resolution.rawPath,
          rawContentHash: hash,
          artifactKind: resolution.artifactKind,
          artifactKey: resolution.artifactKey,
          targetConnectionId: null,
          artifactContentHash: null,
          actionType: resolution.actionType,
        });
        producedPaths.add(resolution.rawPath);
      }
      for (const [rawPath, hash] of currentHashes) {
        if (producedPaths.has(rawPath)) {
          continue;
        }
        provenanceRows.push({
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          rawPath,
          rawContentHash: hash,
          artifactKind: null,
          artifactKey: null,
          targetConnectionId: null,
          artifactContentHash: null,
          actionType: 'skipped',
        });
      }
      await this.deps.provenance.insertMany(provenanceRows);
      memoryFlow?.emit({ type: 'provenance_recorded', rowCount: provenanceRows.length });
      await stage5?.updateProgress(
        1.0,
        `Recorded ${provenanceRows.length} history entr${provenanceRows.length === 1 ? 'y' : 'ies'}`,
      );

      const stage7 = ctx?.startPhase(0.04);
      await stage7?.updateProgress(0.0, 'Wrapping up');

      const reportProvenanceRows = provenanceRows.map(
        ({ rawPath, artifactKind, artifactKey, actionType, targetConnectionId }) => ({
          rawPath,
          artifactKind,
          artifactKey,
          targetConnectionId: targetConnectionId ?? null,
          actionType,
        }),
      );
      const reportToolTranscripts = Array.from(transcriptSummaries.values()).map((summary) => ({
        unitKey: summary.unitKey,
        path: summary.path,
        toolCallCount: summary.toolCallCount,
        errorCount: summary.errorCount,
        toolNames: Array.from(summary.toolNames).sort(),
      }));
      const capturedMemoryFlow = memoryFlow?.snapshot();
      const reportMemoryFlow = capturedMemoryFlow
        ? {
            ...capturedMemoryFlow,
            metadata: {
              schemaVersion: 1 as const,
              mode: 'full' as const,
              origin: 'captured' as const,
              timing: 'captured' as const,
              capturedAt: new Date().toISOString(),
              sourceReportId: null,
              sourceReportPath: null,
              fallbackReason: null,
            },
          }
        : undefined;

      const reportBody = {
        syncId,
        diffSummary,
        fetch: fetchReport ?? undefined,
        commitSha,
        workUnits: stageIndex.workUnits.map((wu) => ({
          unitKey: wu.unitKey,
          rawFiles: wu.rawFiles,
          status: wu.status,
          reason: wu.reason,
          actions: wu.actions,
          touchedSlSources: wu.touchedSlSources,
          slDisallowed: wu.slDisallowed,
          slDisallowedReason: wu.slDisallowedReason,
        })),
        failedWorkUnits,
        reconciliationSkipped: reconcileOutcome.skipped,
        conflictsResolved: stageIndex.conflictsResolved,
        evictionsApplied: stageIndex.evictionsApplied,
        unmappedFallbacks: stageIndex.unmappedFallbacks,
        artifactResolutions: stageIndex.artifactResolutions ?? [],
        evictionInputs: eviction?.deletedRawPaths ?? [],
        reconciliationActions: reconcileActions,
        evictionDecisions: rcToolSession.evictionDecisions ?? [],
        unresolvedCards: unresolvedCards ?? [],
        supersededBy: null,
        overrideOf: overrideReport?.jobId ?? null,
        provenanceRows: reportProvenanceRows,
        toolTranscripts: reportToolTranscripts,
        postProcessor: postProcessorOutcome,
        wikiSlRefRepairs: wikiSlRefRepairResult.repairs,
        wikiSlRefRepairWarnings: wikiSlRefRepairResult.warnings,
        ...(reportMemoryFlow ? { memoryFlow: reportMemoryFlow } : {}),
        context: contextReport
          ? {
              documentsIndexed: contextReport.documentsIndexed,
              chunksIndexed: contextReport.chunksIndexed,
              documentsDeleted: contextReport.documentsDeleted,
              embeddingFailures: contextReport.embeddingFailures,
              candidatesCreated: candidateSummaryAfterReconcile?.total ?? 0,
              candidatesPromoted: candidateSummaryAfterReconcile?.promoted ?? 0,
              candidatesRejected: candidateSummaryAfterReconcile?.rejected ?? 0,
              triage: triageResult?.report,
              dedup: dedupResult?.enabled
                ? {
                    candidatesIn: dedupResult.candidatesIn,
                    clustersOut: dedupResult.clustersOut,
                    mergedCount: dedupResult.mergedCount,
                    largestClusterSize: dedupResult.largestClusterSize,
                    embeddingFailures: dedupResult.embeddingFailures,
                  }
                : undefined,
              curator: curatorReport ?? undefined,
              knowledgeCreates: stageIndex.workUnits
                .flatMap((wu) => wu.actions)
                .concat(reconcileActions)
                .filter((action) => action.target === 'wiki' && action.type === 'created').length,
              knowledgeUpdates: stageIndex.workUnits
                .flatMap((wu) => wu.actions)
                .concat(reconcileActions)
                .filter((action) => action.target === 'wiki' && action.type === 'updated').length,
              capped: sourceContextReport?.capped ?? false,
              warnings: [
                ...new Set([
                  ...contextReport.warnings,
                  ...(sourceContextReport?.warnings ?? []),
                  ...(triageResult?.warnings ?? []),
                  ...(carryForwardResult?.warnings ?? []),
                  ...(dedupResult?.warnings ?? []),
                  ...curatorWarnings,
                ]),
              ],
            }
          : undefined,
      };
      const createdReport = await this.deps.reports.create({
        runId: runRow.id,
        jobId: job.jobId,
        connectionId: job.connectionId,
        sourceKey: job.sourceKey,
        body: reportBody,
      });
      const reportId = reportIdFromCreateResult(createdReport);
      memoryFlow?.update({
        ...(reportId ? { reportId, reportPath: reportId } : {}),
      });
      memoryFlow?.emit({
        type: 'report_created',
        runId: runRow.id,
        ...(reportId ? { reportPath: reportId } : {}),
      });
      if (overrideReport) {
        await this.deps.reports.markSuperseded(overrideReport.jobId, job.jobId);
      }
      if (contextReport && this.deps.contextEvidenceIndex) {
        await this.deps.contextEvidenceIndex.publishSync({
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          diffSet,
        });
      }

      // Stage 7 — status
      await this.deps.runs.markCompleted(
        runRow.id,
        diffSummary,
        fetchReport?.status === 'partial' ? 'partial' : 'completed',
      );
      if (job.bundleRef.kind === 'scheduled_pull') {
        await adapter.onPullSucceeded?.({
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          trigger: job.trigger,
          completedAt: new Date(),
          stagedDir,
        });
      }
      await stage7?.updateProgress(1.0, 'Done');

      cleanupOutcome = 'success';
      return {
        runId: runRow.id,
        syncId,
        diffSummary,
        workUnitCount: workUnits.length,
        failedWorkUnits,
        artifactsWritten: provenanceRows.filter((r) => r.actionType !== 'skipped').length,
        commitSha,
      };
    } finally {
      await this.deps.sessionWorktreeService.cleanup(sessionWorktree, cleanupOutcome);
    }
  }
}
