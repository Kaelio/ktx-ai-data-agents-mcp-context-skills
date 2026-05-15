import type { AgentRunnerPort, AgentToolSet } from '../agent/index.js';
import type { GitService, KtxFileStorePort, KtxLogger, SessionWorktreeService } from '../core/index.js';
import type { PromptService } from '../prompts/index.js';
import type { SkillsRegistryService } from '../skills/index.js';
import type {
  KtxConnectionInfo,
  KtxQueryResult,
  SemanticLayerService,
  SemanticLayerSource,
  SlSearchService,
  SlSourcesIndexPort,
  SlValidationDeps,
  SlValidatorPort,
} from '../sl/index.js';
import type { ToolContext, ToolSession, TouchedSlSourceSet } from '../tools/index.js';
import type { KnowledgeIndexPort, KnowledgeWikiService } from '../wiki/index.js';

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

export interface MemoryAgentSettings {
  knowledge: {
    userScopedKnowledgeEnabled: boolean;
  };
  slValidation: {
    probeRowCount: number;
  };
  llm: {
    memoryIngestionModel: string;
  };
}

export interface MemoryTelemetryPort {
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

export interface MemoryCommitMessagePort {
  enqueueCommitMessageJobForExternalCommit(
    commit: { commitHash: string },
    message: string,
    pathFilter: string,
  ): Promise<void>;
}

export interface MemoryFileStorePort extends KtxFileStorePort<MemoryFileStorePort>, MemoryCommitMessagePort {}

export interface MemoryToolSetLike {
  toAgentTools(context: ToolContext): AgentToolSet;
}

export interface MemoryToolsetFactoryPort {
  createIngestWuToolset(session: ToolSession): MemoryToolSetLike;
  createToolset(capabilities: ['wiki']): MemoryToolSetLike;
}

export interface MemorySlSourceReconcilerPort {
  upsertRow(parsed: SemanticLayerSource, path: string, contentHash: string): Promise<void>;
}

export interface MemoryLockPort {
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
