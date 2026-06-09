import type { AgentRunnerPort, KtxRuntimeToolSet } from '../../context/llm/runtime-port.js';
import type { GitService } from '../../context/core/git.service.js';
import type { KtxFileStorePort } from '../../context/core/file-store.js';
import type { KtxLogger } from '../../context/core/config.js';
import type { SessionWorktreeService } from '../../context/core/session-worktree.service.js';
import type { PromptService } from '../../context/prompts/prompt.service.js';
import type { SkillsRegistryService } from '../../context/skills/skills-registry.service.js';
import type { KtxConnectionInfo, KtxQueryResult, SlSourcesIndexPort } from '../../context/sl/ports.js';
import type { SemanticLayerService } from '../../context/sl/semantic-layer.service.js';
import type { SemanticLayerSource } from '../../context/sl/types.js';
import type { SlSearchService } from '../../context/sl/sl-search.service.js';
import type { SlValidationDeps } from '../../context/sl/tools/sl-warehouse-validation.js';
import type { SlValidatorPort } from '../../context/sl/sl-validator.port.js';
import type { ToolContext } from '../../context/tools/base-tool.js';
import type { ToolSession } from '../../context/tools/tool-session.js';
import type { TouchedSlSourceSet } from '../../context/tools/touched-sl-sources.js';
import type { KnowledgeIndexPort } from '../../context/wiki/ports.js';
import type { KnowledgeWikiService } from '../../context/wiki/knowledge-wiki.service.js';

export type MemoryAgentSourceType = 'research' | 'external_ingest' | 'backfill';

export interface MemoryAgentInput {
  userId: string;
  chatId: string;
  userMessage: string;
  assistantMessage?: string;
  connectionId?: string;
  userMessageId?: string;
  sourceType?: MemoryAgentSourceType;
}

export interface MemoryAction {
  target: 'wiki' | 'sl';
  type: 'created' | 'updated' | 'removed';
  key: string;
  detail: string;
  targetConnectionId?: string | null;
  rawPaths?: string[];
}

export interface MemoryAgentResult {
  signalDetected: boolean;
  actions: MemoryAction[];
  skillsLoaded: string[];
  commitHash: string | null;
}

export interface CaptureSignals {
  knowledge: boolean;
  sl: boolean;
  dialect?: 'lookml';
  reasons: string[];
}

export interface CaptureSession {
  userId: string;
  chatId: string;
  userMessageId?: string;
  userMessage: string;
  connectionId?: string;
  userScopedEnabled: boolean;
  forceGlobalScope: boolean;
  touchedSlSources: TouchedSlSourceSet;
  preHead: string | null;
}

interface MemoryAgentSettings {
  knowledge: {
    userScopedKnowledgeEnabled: boolean;
  };
  slValidation: {
    probeRowCount: number;
  };
  llm: {
    memoryIngestionModel: string;
  };
  /**
   * When false (config `memory.auto_commit: false`), a completed session is applied to the
   * project's working tree and left staged instead of committed, so the user commits it.
   */
  autoCommit: boolean;
}

interface MemoryTelemetryPort {
  trackMemoryIngestion(
    userId: string,
    properties: {
      chat_id: string;
      source_type: MemoryAgentSourceType;
      action_count: number;
      actions: string[];
      skills_loaded: string[];
      signals_detected: string[];
      signals_acted_on: string[];
      reconciled_cross_refs: number;
      session_outcome: 'success' | 'empty' | 'conflict' | 'crash';
    },
  ): void;
}

export interface MemoryKnowledgeSlRefsPort {
  syncFromWiki(args: {
    wikiPageKey: string;
    wikiScope: 'GLOBAL' | 'USER';
    wikiScopeId: string | null;
    refs: Array<{ connectionId: string; sourceName: string }>;
  }): Promise<{ inserted: number; deleted: number }>;
}

export interface MemoryConnectionPort {
  listEnabledConnections(ids: string[]): Promise<KtxConnectionInfo[]>;
  getConnectionById(connectionId: string): Promise<KtxConnectionInfo>;
  executeQuery(connectionId: string, sql: string): Promise<KtxQueryResult>;
}

interface MemoryCommitMessagePort {
  enqueueCommitMessageJobForExternalCommit(
    commit: { commitHash: string },
    message: string,
    pathFilter: string,
  ): Promise<void>;
}

export interface MemoryFileStorePort extends KtxFileStorePort<MemoryFileStorePort>, MemoryCommitMessagePort {}

export interface MemoryToolSetLike {
  toRuntimeTools(context: ToolContext): KtxRuntimeToolSet;
}

export interface MemoryToolsetFactoryPort {
  createIngestWuToolset(session: ToolSession): MemoryToolSetLike;
  createToolset(capabilities: ['wiki']): MemoryToolSetLike;
}

export interface MemorySlSourceReconcilerPort {
  upsertRow(parsed: SemanticLayerSource, path: string, contentHash: string): Promise<void>;
}

interface MemoryLockPort {
  withLock<T>(key: 'config:repo', fn: () => Promise<T>): Promise<T>;
}

export interface MemoryAgentServiceDeps {
  settings: MemoryAgentSettings;
  promptService: PromptService;
  skillsRegistry: SkillsRegistryService;
  wikiService: KnowledgeWikiService;
  knowledgeIndex: KnowledgeIndexPort;
  knowledgeSlRefs: MemoryKnowledgeSlRefsPort;
  semanticLayerService: SemanticLayerService;
  slSearchService: SlSearchService;
  connections: MemoryConnectionPort;
  rootFileStore: MemoryFileStorePort;
  gitService: GitService;
  lockingService: MemoryLockPort;
  slSourcesRepository: SlSourcesIndexPort;
  sessionWorktreeService: SessionWorktreeService<MemoryFileStorePort>;
  semanticLayerSourceReconciler: MemorySlSourceReconcilerPort;
  agentRunner: AgentRunnerPort;
  slValidator: SlValidatorPort<SlValidationDeps>;
  toolsetFactory: MemoryToolsetFactoryPort;
  telemetry?: MemoryTelemetryPort;
  logger?: KtxLogger;
}
