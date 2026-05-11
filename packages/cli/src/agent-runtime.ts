import { readFile } from 'node:fs/promises';
import { createDefaultLocalQueryExecutor, type KtxSqlQueryExecutorPort } from '@ktx/context/connections';
import type { KtxSemanticLayerComputePort } from '@ktx/context/daemon';
import { createLocalProjectMcpContextPorts, type KtxMcpContextPorts } from '@ktx/context/mcp';
import { type KtxLocalProject, loadKtxProject } from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import {
  createManagedPythonSemanticLayerComputePort,
  type KtxManagedPythonInstallPolicy,
} from './managed-python-command.js';

export const KTX_AGENT_MAX_ROWS_CAP = 1000;

export interface KtxAgentRuntimeOptions {
  projectDir: string;
  enableSemanticCompute: boolean;
  enableQueryExecution: boolean;
  cliVersion?: string;
  runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
  io?: KtxCliIo;
}

export interface KtxAgentRuntime {
  project: KtxLocalProject;
  ports: KtxMcpContextPorts;
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
}

export interface KtxAgentRuntimeDeps {
  loadProject?: typeof loadKtxProject;
  createContextTools?: typeof createLocalProjectMcpContextPorts;
  createSemanticLayerCompute?: () => KtxSemanticLayerComputePort;
  createManagedSemanticLayerCompute?: typeof createManagedPythonSemanticLayerComputePort;
  createQueryExecutor?: () => KtxSqlQueryExecutorPort;
}

export function writeAgentJson(io: KtxCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeAgentJsonError(
  io: KtxCliIo,
  message: string,
  detail: Record<string, unknown> = {},
): void {
  io.stderr.write(`${JSON.stringify({ ok: false, error: { message, ...detail } }, null, 2)}\n`);
}

export async function readAgentJsonFile(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function parseAgentMaxRows(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    throw new Error('maxRows is required and must be a positive integer.');
  }
  if (value > KTX_AGENT_MAX_ROWS_CAP) {
    throw new Error(`maxRows must be less than or equal to ${KTX_AGENT_MAX_ROWS_CAP}.`);
  }
  return value;
}

async function createAgentSemanticLayerCompute(
  options: KtxAgentRuntimeOptions,
  deps: KtxAgentRuntimeDeps,
): Promise<KtxSemanticLayerComputePort | undefined> {
  if (!options.enableSemanticCompute) {
    return undefined;
  }
  if (deps.createSemanticLayerCompute) {
    return deps.createSemanticLayerCompute();
  }
  if (!options.cliVersion || !options.runtimeInstallPolicy || !options.io) {
    throw new Error('Managed Python semantic compute requires cliVersion, runtimeInstallPolicy, and io.');
  }
  const createManagedSemanticLayerCompute =
    deps.createManagedSemanticLayerCompute ?? createManagedPythonSemanticLayerComputePort;
  return createManagedSemanticLayerCompute({
    cliVersion: options.cliVersion,
    installPolicy: options.runtimeInstallPolicy,
    io: options.io,
  });
}

export async function createKtxAgentRuntime(
  options: KtxAgentRuntimeOptions,
  deps: KtxAgentRuntimeDeps = {},
): Promise<KtxAgentRuntime> {
  const project = await (deps.loadProject ?? loadKtxProject)({ projectDir: options.projectDir });
  const semanticLayerCompute = await createAgentSemanticLayerCompute(options, deps);
  const queryExecutor = options.enableQueryExecution
    ? (deps.createQueryExecutor ?? createDefaultLocalQueryExecutor)()
    : undefined;
  const ports = (deps.createContextTools ?? createLocalProjectMcpContextPorts)(project, {
    ...(semanticLayerCompute ? { semanticLayerCompute } : {}),
    ...(queryExecutor ? { queryExecutor } : {}),
  });
  return {
    project,
    ports,
    ...(semanticLayerCompute ? { semanticLayerCompute } : {}),
    ...(queryExecutor ? { queryExecutor } : {}),
  };
}
