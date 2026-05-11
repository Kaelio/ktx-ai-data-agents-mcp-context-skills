# Managed Agent and MCP Semantic Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make hidden agent semantic queries and MCP semantic compute use the
KTX-managed core Python runtime instead of relying on a user-provided
`python -m ktx_daemon`.

**Architecture:** Reuse the existing managed runtime command helper so every
CLI semantic compute surface resolves the same bundled `ktx-daemon` executable.
Keep explicit HTTP daemon URLs working for `ktx serve --semantic-compute-url`,
and add runtime install policy flags where commands can lazily install the core
runtime.

**Tech Stack:** TypeScript, Commander, Vitest, KTX CLI managed Python runtime,
`@ktx/context/daemon`.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

The following plans are based on that spec and are already implemented in this
worktree:

- `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-command-integration.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-daemon-lifecycle.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-runtime.md`
- `docs/superpowers/plans/2026-05-11-public-kaelio-ktx-npm-package.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-release-smoke.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-release-smoke.md`

Implementation evidence found before writing this plan includes:

- `scripts/build-python-runtime-wheel.mjs` and
  `packages/cli/assets/python/manifest.json`.
- `packages/cli/src/managed-python-runtime.ts`,
  `packages/cli/src/runtime.ts`, and
  `packages/cli/src/commands/runtime-commands.ts`.
- `packages/cli/src/managed-python-command.ts` and `ktx sl query` runtime
  install policy flags.
- `packages/cli/src/managed-python-daemon.ts`, daemon state files, and
  `ktx runtime start` / `ktx runtime stop`.
- `packages/cli/src/managed-local-embeddings.ts` and setup embedding wiring.
- `scripts/build-public-npm-package.mjs`, `release-policy.json`, and release
  smoke coverage for `@kaelio/ktx`.
- `scripts/package-artifacts.mjs` release smoke coverage for lazy core runtime
  install, `ktx sl query`, runtime status, doctor, daemon start, daemon reuse,
  and daemon stop.
- `scripts/local-embeddings-runtime-smoke.mjs` opt-in release smoke coverage
  for `local-embeddings`.

The next remaining semantic compute gap is that these CLI paths still create a
raw Python semantic-layer compute port:

- `packages/cli/src/agent-runtime.ts`
- `packages/cli/src/serve.ts`

Those paths can call `semantic-query`, `semantic-validate`, and
`semantic-generate-sources` through `@ktx/context/daemon`, so they must resolve
the managed runtime just like `ktx sl query`.

This plan intentionally does not change live-database introspection or Looker
table-identifier parsing. Those use daemon HTTP endpoints through local ingest
adapters and fit a separate managed-daemon adapter plan.

## File structure

- Modify `packages/cli/src/managed-python-command.ts`: export a shared
  `runtimeInstallPolicyFromFlags()` helper so CLI commands do not duplicate
  `--yes` / `--no-input` behavior.
- Modify `packages/cli/src/managed-python-command.test.ts`: cover the shared
  policy helper.
- Modify `packages/cli/src/commands/sl-commands.ts`: replace its private
  runtime policy helper with the shared helper.
- Modify `packages/cli/src/agent-runtime.ts`: create managed semantic compute
  when agent SL query needs Python and no dependency override is injected.
- Modify `packages/cli/src/agent-runtime.test.ts`: cover the managed agent
  runtime path.
- Modify `packages/cli/src/agent.ts`: pass CLI version, install policy, and
  CLI IO into default agent runtime creation for `sl-query`.
- Modify `packages/cli/src/agent.test.ts`: cover runtime options passed through
  agent SL query execution.
- Modify `packages/cli/src/commands/agent-commands.ts`: add `--yes` and
  `--no-input` to hidden `ktx agent sl query`.
- Modify `packages/cli/src/serve.ts`: create managed semantic compute for
  `ktx serve --semantic-compute` when no explicit HTTP URL is provided.
- Modify `packages/cli/src/serve.test.ts`: cover the managed MCP semantic
  compute path.
- Modify `packages/cli/src/commands/serve-commands.ts`: add `--yes` and
  `--no-input` to `ktx serve`.
- Modify `packages/cli/src/index.test.ts`: update CLI argument routing for the
  new managed runtime policy fields.

### Task 1: Share managed runtime install policy parsing

**Files:**

- Modify: `packages/cli/src/managed-python-command.test.ts`
- Modify: `packages/cli/src/managed-python-command.ts`
- Modify: `packages/cli/src/commands/sl-commands.ts`
- Test: `packages/cli/src/managed-python-command.test.ts`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Write failing policy helper tests**

In `packages/cli/src/managed-python-command.test.ts`, update the import from
`./managed-python-command.js` to include `runtimeInstallPolicyFromFlags`:

```typescript
import {
  createManagedPythonSemanticLayerComputePort,
  managedRuntimeInstallCommand,
  runtimeInstallPolicyFromFlags,
} from './managed-python-command.js';
```

Add this block after the existing `describe('managedRuntimeInstallCommand', ...)`
block:

```typescript
describe('runtimeInstallPolicyFromFlags', () => {
  it('maps command flags to managed runtime install policies', () => {
    expect(runtimeInstallPolicyFromFlags({})).toBe('prompt');
    expect(runtimeInstallPolicyFromFlags({ yes: false })).toBe('prompt');
    expect(runtimeInstallPolicyFromFlags({ yes: true })).toBe('auto');
    expect(runtimeInstallPolicyFromFlags({ input: false })).toBe('never');
  });

  it('rejects conflicting runtime install flags', () => {
    expect(() => runtimeInstallPolicyFromFlags({ yes: true, input: false })).toThrow(
      'Choose only one runtime install mode: --yes or --no-input',
    );
  });
});
```

- [ ] **Step 2: Run the failing helper tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-command.test.ts
```

Expected: FAIL with an import error for `runtimeInstallPolicyFromFlags`.

- [ ] **Step 3: Export the shared policy helper**

In `packages/cli/src/managed-python-command.ts`, add this function immediately
after the `KtxManagedPythonInstallPolicy` type:

```typescript
export function runtimeInstallPolicyFromFlags(options: {
  yes?: boolean;
  input?: boolean;
}): KtxManagedPythonInstallPolicy {
  if (options.yes === true && options.input === false) {
    throw new Error('Choose only one runtime install mode: --yes or --no-input');
  }
  if (options.yes === true) {
    return 'auto';
  }
  return options.input === false ? 'never' : 'prompt';
}
```

- [ ] **Step 4: Replace the private SL policy helper**

In `packages/cli/src/commands/sl-commands.ts`, replace this import:

```typescript
import type { KtxManagedPythonInstallPolicy } from '../managed-python-command.js';
```

with this import:

```typescript
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
```

Delete this private function from `packages/cli/src/commands/sl-commands.ts`:

```typescript
function runtimeInstallPolicy(options: { yes?: boolean; input?: boolean }): KtxManagedPythonInstallPolicy {
  if (options.yes === true && options.input === false) {
    throw new Error('Choose only one runtime install mode: --yes or --no-input');
  }
  if (options.yes === true) {
    return 'auto';
  }
  return options.input === false ? 'never' : 'prompt';
}
```

In the `sl.command('query')` action, replace:

```typescript
runtimeInstallPolicy: runtimeInstallPolicy(options),
```

with:

```typescript
runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
```

- [ ] **Step 5: Run focused helper and routing tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-command.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the shared helper**

```bash
git add packages/cli/src/managed-python-command.ts packages/cli/src/managed-python-command.test.ts packages/cli/src/commands/sl-commands.ts
git commit -m "refactor: share managed runtime install policy parsing"
```

### Task 2: Use managed semantic compute for hidden agent SL query

**Files:**

- Modify: `packages/cli/src/agent-runtime.test.ts`
- Modify: `packages/cli/src/agent-runtime.ts`
- Modify: `packages/cli/src/agent.test.ts`
- Modify: `packages/cli/src/agent.ts`
- Modify: `packages/cli/src/commands/agent-commands.ts`
- Modify: `packages/cli/src/index.test.ts`
- Test: `packages/cli/src/agent-runtime.test.ts`
- Test: `packages/cli/src/agent.test.ts`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Add failing agent runtime tests**

In `packages/cli/src/agent-runtime.test.ts`, add this test after
`constructs local context ports with semantic compute and query executor`:

```typescript
  it('creates managed semantic compute when no test override is injected', async () => {
    const project = {
      projectDir: tempDir,
      configPath: join(tempDir, 'ktx.yaml'),
      config: { project: 'revenue', connections: {} },
      coreConfig: {},
      git: {},
      fileStore: {},
    } as never;
    const ports = { semanticLayer: {} } as never;
    const semanticLayerCompute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const loadProject = vi.fn(async () => project);
    const createContextTools = vi.fn(() => ports);
    const createManagedSemanticLayerCompute = vi.fn(async () => semanticLayerCompute);
    const { io } = makeIo();

    await expect(
      createKtxAgentRuntime(
        {
          projectDir: tempDir,
          enableSemanticCompute: true,
          enableQueryExecution: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
          io,
        },
        {
          loadProject,
          createContextTools,
          createManagedSemanticLayerCompute,
        },
      ),
    ).resolves.toMatchObject({ project, ports, semanticLayerCompute });

    expect(createManagedSemanticLayerCompute).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io,
    });
    expect(createContextTools).toHaveBeenCalledWith(project, {
      semanticLayerCompute,
    });
  });
```

- [ ] **Step 2: Add failing agent command/runtime tests**

In `packages/cli/src/agent.test.ts`, update the existing
`executes SL queries from a JSON query file` test so the `sl-query` args include
the managed runtime fields:

```typescript
        {
          command: 'sl-query',
          projectDir: tempDir,
          json: true,
          connectionId: 'warehouse',
          queryFile,
          execute: true,
          maxRows: 100,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'never',
        },
```

Add this test immediately after `executes SL queries from a JSON query file`:

```typescript
  it('passes managed runtime options into default SL query runtime creation', async () => {
    const queryFile = join(tempDir, 'sl-query.json');
    const io = makeIo();
    const createRuntime = vi.fn(async () => runtime());
    await writeFile(queryFile, '{"measures":["total_revenue"],"dimensions":[]}', 'utf-8');

    await expect(
      runKtxAgent(
        {
          command: 'sl-query',
          projectDir: tempDir,
          json: true,
          connectionId: 'warehouse',
          queryFile,
          execute: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        io.io,
        { createRuntime },
      ),
    ).resolves.toBe(0);

    expect(createRuntime).toHaveBeenCalledWith({
      projectDir: tempDir,
      enableSemanticCompute: true,
      enableQueryExecution: false,
      cliVersion: '0.2.0',
      runtimeInstallPolicy: 'auto',
      io: io.io,
    });
  });
```

- [ ] **Step 3: Add failing CLI routing tests**

In `packages/cli/src/index.test.ts`, update the existing
`dispatches full hidden agent commands without exposing agent in root help`
case for `agent sl query` so its expected args include:

```typescript
          cliVersion: '0.0.0-private',
          runtimeInstallPolicy: 'prompt',
```

Add this test after that existing full hidden agent command test:

```typescript
  it('routes hidden agent SL query managed runtime policies', async () => {
    const autoIo = makeIo();
    const neverIo = makeIo();
    const conflictIo = makeIo();
    const agent = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'agent',
          'sl',
          'query',
          '--json',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--yes',
        ],
        autoIo.io,
        { agent },
      ),
    ).resolves.toBe(0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'agent',
          'sl',
          'query',
          '--json',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--no-input',
        ],
        neverIo.io,
        { agent },
      ),
    ).resolves.toBe(0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'agent',
          'sl',
          'query',
          '--json',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--yes',
          '--no-input',
        ],
        conflictIo.io,
        { agent },
      ),
    ).resolves.toBe(1);

    expect(agent).toHaveBeenNthCalledWith(
      1,
      {
        command: 'sl-query',
        projectDir: tempDir,
        json: true,
        connectionId: 'warehouse',
        queryFile: '/tmp/query.json',
        execute: false,
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'auto',
      },
      autoIo.io,
    );
    expect(agent).toHaveBeenNthCalledWith(
      2,
      {
        command: 'sl-query',
        projectDir: tempDir,
        json: true,
        connectionId: 'warehouse',
        queryFile: '/tmp/query.json',
        execute: false,
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'never',
      },
      neverIo.io,
    );
    expect(conflictIo.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });
```

- [ ] **Step 4: Run the failing agent tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/agent-runtime.test.ts src/agent.test.ts src/index.test.ts
```

Expected: FAIL with TypeScript or runtime errors for
`createManagedSemanticLayerCompute`, missing `cliVersion`, missing
`runtimeInstallPolicy`, or unsupported hidden agent `--yes` / `--no-input`.

- [ ] **Step 5: Implement managed agent runtime creation**

In `packages/cli/src/agent-runtime.ts`, replace the direct
`@ktx/context/daemon` import:

```typescript
import { createPythonSemanticLayerComputePort, type KtxSemanticLayerComputePort } from '@ktx/context/daemon';
```

with:

```typescript
import type { KtxSemanticLayerComputePort } from '@ktx/context/daemon';
import {
  createManagedPythonSemanticLayerComputePort,
  type KtxManagedPythonInstallPolicy,
} from './managed-python-command.js';
```

Update `KtxAgentRuntimeOptions` to:

```typescript
export interface KtxAgentRuntimeOptions {
  projectDir: string;
  enableSemanticCompute: boolean;
  enableQueryExecution: boolean;
  cliVersion?: string;
  runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
  io?: KtxCliIo;
}
```

Update `KtxAgentRuntimeDeps` to:

```typescript
export interface KtxAgentRuntimeDeps {
  loadProject?: typeof loadKtxProject;
  createContextTools?: typeof createLocalProjectMcpContextPorts;
  createSemanticLayerCompute?: () => KtxSemanticLayerComputePort;
  createManagedSemanticLayerCompute?: typeof createManagedPythonSemanticLayerComputePort;
  createQueryExecutor?: () => KtxSqlQueryExecutorPort;
}
```

Add this helper before `createKtxAgentRuntime`:

```typescript
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
```

In `createKtxAgentRuntime`, replace:

```typescript
  const semanticLayerCompute = options.enableSemanticCompute
    ? (deps.createSemanticLayerCompute ?? createPythonSemanticLayerComputePort)()
    : undefined;
```

with:

```typescript
  const semanticLayerCompute = await createAgentSemanticLayerCompute(options, deps);
```

- [ ] **Step 6: Pass runtime options through agent execution**

In `packages/cli/src/agent.ts`, add this import:

```typescript
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
```

Update the `sl-query` variant in `KtxAgentArgs` to:

```typescript
  | {
      command: 'sl-query';
      projectDir: string;
      json: true;
      connectionId: string;
      queryFile: string;
      execute: boolean;
      maxRows?: number;
      cliVersion: string;
      runtimeInstallPolicy: KtxManagedPythonInstallPolicy;
    }
```

Update `KtxAgentDeps.createRuntime` to use the shared runtime options type:

```typescript
  createRuntime?: (options: {
    projectDir: string;
    enableSemanticCompute: boolean;
    enableQueryExecution: boolean;
    cliVersion?: string;
    runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
    io?: KtxCliIo;
  }) => Promise<KtxAgentRuntime>;
```

Change `runtimeFor` from:

```typescript
async function runtimeFor(args: KtxAgentArgs, deps: KtxAgentDeps): Promise<KtxAgentRuntime> {
  const needsSemanticCompute = args.command === 'sl-query';
  const needsQueryExecution = args.command === 'sql-execute' || (args.command === 'sl-query' && args.execute);
  return deps.createRuntime
    ? deps.createRuntime({
        projectDir: args.projectDir,
        enableSemanticCompute: needsSemanticCompute,
        enableQueryExecution: needsQueryExecution,
      })
    : createKtxAgentRuntime(
        {
          projectDir: args.projectDir,
          enableSemanticCompute: needsSemanticCompute,
          enableQueryExecution: needsQueryExecution,
        },
        deps,
      );
}
```

to:

```typescript
async function runtimeFor(args: KtxAgentArgs, deps: KtxAgentDeps, io: KtxCliIo): Promise<KtxAgentRuntime> {
  const needsSemanticCompute = args.command === 'sl-query';
  const needsQueryExecution = args.command === 'sql-execute' || (args.command === 'sl-query' && args.execute);
  const runtimeOptions = {
    projectDir: args.projectDir,
    enableSemanticCompute: needsSemanticCompute,
    enableQueryExecution: needsQueryExecution,
    ...(args.command === 'sl-query'
      ? {
          cliVersion: args.cliVersion,
          runtimeInstallPolicy: args.runtimeInstallPolicy,
          io,
        }
      : {}),
  };
  return deps.createRuntime ? deps.createRuntime(runtimeOptions) : createKtxAgentRuntime(runtimeOptions, deps);
}
```

In `runKtxAgent`, replace:

```typescript
    const runtime = await runtimeFor(args, deps);
```

with:

```typescript
    const runtime = await runtimeFor(args, deps, io);
```

- [ ] **Step 7: Add hidden agent runtime policy flags**

In `packages/cli/src/commands/agent-commands.ts`, add this import:

```typescript
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
```

In the `agent sl query` command chain, add these options after
`.option('--execute', ...)`:

```typescript
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
    .option('--no-input', 'Disable interactive managed runtime installation')
```

Update the action options type from:

```typescript
        options: { connectionId: string; queryFile: string; execute: boolean; maxRows?: number },
```

to:

```typescript
        options: {
          connectionId: string;
          queryFile: string;
          execute: boolean;
          maxRows?: number;
          yes?: boolean;
          input?: boolean;
        },
```

Add these fields to the `runAgent` argument object:

```typescript
          cliVersion: context.packageInfo.version,
          runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
```

- [ ] **Step 8: Run focused agent tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/agent-runtime.test.ts src/agent.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the agent integration**

```bash
git add packages/cli/src/agent-runtime.ts packages/cli/src/agent-runtime.test.ts packages/cli/src/agent.ts packages/cli/src/agent.test.ts packages/cli/src/commands/agent-commands.ts packages/cli/src/index.test.ts
git commit -m "feat: use managed runtime for agent semantic queries"
```

### Task 3: Use managed semantic compute for MCP serve

**Files:**

- Modify: `packages/cli/src/serve.test.ts`
- Modify: `packages/cli/src/serve.ts`
- Modify: `packages/cli/src/commands/serve-commands.ts`
- Modify: `packages/cli/src/index.test.ts`
- Test: `packages/cli/src/serve.test.ts`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Add a failing serve managed runtime test**

In `packages/cli/src/serve.test.ts`, add this helper after the imports:

```typescript
function makeManagedRuntimeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
```

Add this test before `uses the HTTP semantic compute port when a daemon URL is
provided`:

```typescript
  it('uses managed semantic compute when MCP semantic compute has no explicit HTTP URL', async () => {
    const project = { projectDir: '/tmp/ktx-project', config: { connections: {} } } as never;
    const semanticLayerCompute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const createManagedSemanticLayerCompute = vi.fn(async () => semanticLayerCompute);
    const createContextTools = vi.fn(() => ({ connections: { list: async () => [] } }));
    const managedRuntimeIo = makeManagedRuntimeIo();

    await expect(
      runKtxServeStdio(
        {
          mcp: 'stdio',
          projectDir: '/tmp/ktx-project',
          userId: 'agent',
          semanticCompute: true,
          semanticComputeUrl: undefined,
          databaseIntrospectionUrl: undefined,
          executeQueries: false,
          memoryCapture: false,
          memoryModel: undefined,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        {
          loadProject: async () => project,
          createContextTools,
          createManagedSemanticLayerCompute,
          managedRuntimeIo: managedRuntimeIo.io,
          createServer: vi.fn(() => ({ connect: vi.fn(async () => undefined) }) as never),
          createTransport: vi.fn(() => ({}) as never),
          stderr: { write: vi.fn() },
        },
      ),
    ).resolves.toBe(0);

    expect(createManagedSemanticLayerCompute).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: managedRuntimeIo.io,
    });
    expect(createContextTools).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        semanticLayerCompute,
      }),
    );
  });
```

- [ ] **Step 2: Add failing serve routing tests**

In `packages/cli/src/index.test.ts`, update both existing `serveStdio`
expectations so the expected args include:

```typescript
      cliVersion: '0.0.0-private',
      runtimeInstallPolicy: 'prompt',
```

Add this test after `dispatches serve public command options through Commander`:

```typescript
  it('routes serve managed runtime install policies', async () => {
    const autoIo = makeIo();
    const neverIo = makeIo();
    const conflictIo = makeIo();
    const serveStdio = vi.fn(async () => 0);

    await expect(
      runKtxCli(['serve', '--mcp', 'stdio', '--project-dir', tempDir, '--semantic-compute', '--yes'], autoIo.io, {
        serveStdio,
      }),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(['serve', '--mcp', 'stdio', '--project-dir', tempDir, '--semantic-compute', '--no-input'], neverIo.io, {
        serveStdio,
      }),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(
        ['serve', '--mcp', 'stdio', '--project-dir', tempDir, '--semantic-compute', '--yes', '--no-input'],
        conflictIo.io,
        { serveStdio },
      ),
    ).resolves.toBe(1);

    expect(serveStdio).toHaveBeenNthCalledWith(1, {
      mcp: 'stdio',
      projectDir: tempDir,
      userId: 'local',
      semanticCompute: true,
      semanticComputeUrl: undefined,
      databaseIntrospectionUrl: undefined,
      executeQueries: false,
      memoryCapture: false,
      memoryModel: undefined,
      cliVersion: '0.0.0-private',
      runtimeInstallPolicy: 'auto',
    });
    expect(serveStdio).toHaveBeenNthCalledWith(2, {
      mcp: 'stdio',
      projectDir: tempDir,
      userId: 'local',
      semanticCompute: true,
      semanticComputeUrl: undefined,
      databaseIntrospectionUrl: undefined,
      executeQueries: false,
      memoryCapture: false,
      memoryModel: undefined,
      cliVersion: '0.0.0-private',
      runtimeInstallPolicy: 'never',
    });
    expect(conflictIo.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });
```

- [ ] **Step 3: Run the failing serve tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/serve.test.ts src/index.test.ts
```

Expected: FAIL with missing `createManagedSemanticLayerCompute` support and
missing `cliVersion` / `runtimeInstallPolicy` fields in command routing.

- [ ] **Step 4: Implement managed serve semantic compute**

In `packages/cli/src/serve.ts`, add this import:

```typescript
import type { KtxCliIo } from './cli-runtime.js';
import {
  createManagedPythonSemanticLayerComputePort,
  type KtxManagedPythonInstallPolicy,
} from './managed-python-command.js';
```

Update `KtxServeArgs` to:

```typescript
export interface KtxServeArgs {
  mcp: 'stdio';
  projectDir: string;
  userId: string;
  semanticCompute: boolean;
  semanticComputeUrl?: string;
  databaseIntrospectionUrl?: string;
  executeQueries: boolean;
  memoryCapture: boolean;
  memoryModel?: string;
  cliVersion?: string;
  runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
}
```

Update `KtxServeDeps` to include:

```typescript
  createManagedSemanticLayerCompute?: typeof createManagedPythonSemanticLayerComputePort;
  managedRuntimeIo?: KtxCliIo;
```

Add these helpers before `runKtxServeStdio`:

```typescript
function requiredManagedRuntimeCliVersion(args: KtxServeArgs): string {
  if (!args.cliVersion) {
    throw new Error('Managed Python semantic compute requires a CLI version.');
  }
  return args.cliVersion;
}

async function createServeSemanticLayerCompute(
  args: KtxServeArgs,
  deps: KtxServeDeps,
): Promise<KtxSemanticLayerComputePort | undefined> {
  if (!args.semanticCompute) {
    return undefined;
  }
  if (args.semanticComputeUrl) {
    return (deps.createHttpSemanticLayerCompute ?? ((baseUrl) => createHttpSemanticLayerComputePort({ baseUrl })))(
      args.semanticComputeUrl,
    );
  }
  if (deps.createSemanticLayerCompute) {
    return deps.createSemanticLayerCompute();
  }
  const createManagedSemanticLayerCompute =
    deps.createManagedSemanticLayerCompute ?? createManagedPythonSemanticLayerComputePort;
  return createManagedSemanticLayerCompute({
    cliVersion: requiredManagedRuntimeCliVersion(args),
    installPolicy: args.runtimeInstallPolicy ?? 'prompt',
    io: deps.managedRuntimeIo ?? process,
  });
}
```

In `runKtxServeStdio`, replace:

```typescript
  const semanticLayerCompute = args.semanticCompute
    ? args.semanticComputeUrl
      ? (deps.createHttpSemanticLayerCompute ?? ((baseUrl) => createHttpSemanticLayerComputePort({ baseUrl })))(
          args.semanticComputeUrl,
        )
      : (deps.createSemanticLayerCompute ?? createPythonSemanticLayerComputePort)()
    : undefined;
```

with:

```typescript
  const semanticLayerCompute = await createServeSemanticLayerCompute(args, deps);
```

Remove `createPythonSemanticLayerComputePort` from the
`@ktx/context/daemon` import list.

- [ ] **Step 5: Add serve runtime policy flags**

In `packages/cli/src/commands/serve-commands.ts`, add this import:

```typescript
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
```

Add these command options after `.option('--semantic-compute-url <url>', ...)`:

```typescript
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
    .option('--no-input', 'Disable interactive managed runtime installation')
```

Add these fields to the `KtxServeArgs` object:

```typescript
        cliVersion: context.packageInfo.version,
        runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
```

- [ ] **Step 6: Run focused serve tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/serve.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the serve integration**

```bash
git add packages/cli/src/serve.ts packages/cli/src/serve.test.ts packages/cli/src/commands/serve-commands.ts packages/cli/src/index.test.ts
git commit -m "feat: use managed runtime for MCP semantic compute"
```

### Task 4: Verify managed semantic runtime integration

**Files:**

- Verify: `packages/cli/src/managed-python-command.ts`
- Verify: `packages/cli/src/agent-runtime.ts`
- Verify: `packages/cli/src/agent.ts`
- Verify: `packages/cli/src/commands/agent-commands.ts`
- Verify: `packages/cli/src/serve.ts`
- Verify: `packages/cli/src/commands/serve-commands.ts`
- Verify: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Run all focused CLI tests touched by this plan**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-command.test.ts src/agent-runtime.test.ts src/agent.test.ts src/serve.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Run CLI tests**

Run:

```bash
pnpm --filter @ktx/cli run test
```

Expected: PASS.

- [ ] **Step 4: Run package build**

Run:

```bash
pnpm --filter @ktx/cli run build
```

Expected: PASS.

- [ ] **Step 5: Commit any verification fixes**

If verification required code edits, run:

```bash
git add packages/cli/src/managed-python-command.ts packages/cli/src/managed-python-command.test.ts packages/cli/src/commands/sl-commands.ts packages/cli/src/agent-runtime.ts packages/cli/src/agent-runtime.test.ts packages/cli/src/agent.ts packages/cli/src/agent.test.ts packages/cli/src/commands/agent-commands.ts packages/cli/src/serve.ts packages/cli/src/serve.test.ts packages/cli/src/commands/serve-commands.ts packages/cli/src/index.test.ts
git commit -m "fix: verify managed semantic runtime surfaces"
```

If no files changed after Step 1 through Step 4, do not create an empty commit.

## Acceptance criteria

- `ktx agent sl query` has `--yes` and `--no-input` managed runtime policy
  flags.
- `ktx agent sl query --yes` passes `runtimeInstallPolicy: 'auto'` and the
  current CLI package version into default runtime creation.
- `ktx agent sl query --no-input` passes `runtimeInstallPolicy: 'never'`.
- `ktx agent sl query --yes --no-input` exits with
  `Choose only one runtime install mode: --yes or --no-input`.
- Default agent SL query runtime creation uses
  `createManagedPythonSemanticLayerComputePort()` and therefore invokes the
  bundled managed `ktx-daemon` executable.
- `ktx serve --mcp stdio --semantic-compute` has `--yes` and `--no-input`
  managed runtime policy flags.
- `ktx serve --mcp stdio --semantic-compute --yes` passes
  `runtimeInstallPolicy: 'auto'` and the current CLI package version into
  serve runtime creation.
- `ktx serve --mcp stdio --semantic-compute --no-input` passes
  `runtimeInstallPolicy: 'never'`.
- `ktx serve --mcp stdio --semantic-compute-url <url>` continues to use the
  explicit HTTP semantic compute port and does not install or start a managed
  runtime.
- Focused CLI tests, full CLI tests, CLI type-check, and CLI build pass.

## Self-review

- Spec coverage: this plan extends managed Python one-shot semantic compute to
  hidden agent SL query and MCP `serve --semantic-compute`, covering additional
  semantic query, validation, and source-generation paths that use
  `@ktx/context/daemon`.
- Remaining intentional gap: local ingest daemon-backed database introspection
  and Looker SQL table-identifier parsing still need a managed daemon adapter
  plan because they use HTTP daemon endpoints rather than the one-shot semantic
  compute port.
- Placeholder scan: all steps contain concrete edits, commands, and expected
  results.
- Type consistency: runtime policy values stay `prompt`, `auto`, and `never`;
  runtime feature values stay `core` and `local-embeddings`; package version
  fields are named `cliVersion`.
