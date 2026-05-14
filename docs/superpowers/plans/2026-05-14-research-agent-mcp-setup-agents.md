# Research Agent MCP Setup Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ktx setup-agents` install the `ktx-research` skill and configure or print MCP client entries that point agents at the local `ktx mcp` HTTP endpoint.

**Architecture:** Keep `packages/cli/src/setup-agents.ts` as the setup orchestration point. Add a small MCP-client config planner/writer in the same module, backed by `.ktx/mcp.json` when present, and install the research skill from a copied runtime asset so source checkouts and published CLI builds use the same `SKILL.md`.

**Tech Stack:** TypeScript, Vitest, Node fs/path APIs, Commander setup options, KTX MCP daemon state, JSON config writers.

---

## Current Audit

Original spec: `docs/superpowers/specs/2026-05-14-research-agent-mcp-tools-design.md`

Implemented v1 slices confirmed in current source:

- MCP `sql_execution`, `entity_details`, `dictionary_search`, and `discover_data` are registered in `packages/context/src/mcp/context-tools.ts`.
- Local project MCP ports wire all four tools in `packages/context/src/mcp/local-project-ports.ts`.
- Parser-backed SQL validation exists in `python/ktx-daemon/src/ktx_daemon/sql_analysis.py` and is exposed through `POST /sql/validate-read-only`.
- `ktx mcp start|stop|status|logs` exists in `packages/cli/src/commands/mcp-commands.ts`, with HTTP hosting in `packages/cli/src/mcp-http-server.ts` and daemon state in `packages/cli/src/managed-mcp-daemon.ts`.
- Targeted verification passed:
  - `pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts src/search/discover.test.ts src/scan/entity-details.test.ts src/sl/dictionary-search.test.ts`
  - `pnpm --filter @ktx/cli exec vitest run src/mcp-http-server.test.ts src/managed-mcp-daemon.test.ts src/commands/mcp-commands.test.ts src/setup-agents.test.ts`

V1-blocking gaps remaining against the original spec:

- `ktx setup-agents` still installs only the existing `ktx` agent files; it does not install `ktx-research`.
- `ktx setup-agents` does not write Claude Code or Cursor MCP JSON config entries.
- `ktx setup-agents` does not print Codex or opencode copy-paste snippets.
- `ktx setup-agents --remove` cannot remove written MCP JSON keys because none are written or tracked.
- The ingest-side warehouse-verification tools still use `connectionName`, `targets`, and `rowLimit`, and `WarehouseCatalogService` still exposes connection-name terminology. That is a separate v1-blocking subsystem and is not mixed into this setup-agent plan.

Non-blocking or explicitly out-of-scope gaps:

- Python code execution over MCP.
- Stdio MCP transport.
- OS-level auto-start.
- Native TLS, audit logging, rate limiting, per-tool authorization, and multi-project daemon routing.
- Streaming SQL results.

## File Structure

Create:

- `packages/cli/src/skills/research/SKILL.md`
  - Canonical research skill body from the spec.
  - Copied into `dist/skills/research/SKILL.md` during `@ktx/cli` build.
- `packages/cli/scripts/copy-runtime-assets.mjs`
  - Copies `src/skills` into `dist/skills` after TypeScript compilation.

Modify:

- `packages/cli/package.json`
  - Append the runtime asset copy step to the `build` script.
- `packages/cli/src/setup-agents.ts`
  - Add `local` agent scope for Claude Code's per-project private config path.
  - Add `research-skill` file entries in `plannedKtxAgentFiles()`.
  - Read the research skill asset when writing research-skill entries.
  - Add MCP endpoint resolution from `.ktx/mcp.json`, falling back to `http://localhost:7878/mcp`.
  - Add JSON writers for Claude Code and Cursor MCP entries.
  - Add printed snippets for Codex and opencode.
  - Track written JSON keys in the install manifest.
  - Print the daemon-start hint when the daemon is not currently running.
- `packages/cli/src/setup-agents.test.ts`
  - Cover research skill install paths, MCP JSON writers, snippets, manifest removal, token handling, and no literal-token rendering.
- `packages/cli/src/commands/setup-commands.ts`
  - Add `--local` for Claude Code local-scope setup.
  - Reject `--local` with non-Claude targets and reject `--local --global`.
- `packages/cli/src/setup.ts`
  - No behavior change beyond accepting `KtxAgentScope` with the new `local` value.
- `packages/cli/src/cli-program.ts`
  - Keep the default bare setup `agentScope: 'project'`; no code change needed unless TypeScript requires the widened scope type in nearby annotations.

## Task 1: Add The Research Skill Runtime Asset

**Files:**
- Create: `packages/cli/src/skills/research/SKILL.md`
- Create: `packages/cli/scripts/copy-runtime-assets.mjs`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/setup-agents.test.ts`
- Modify: `packages/cli/src/setup-agents.ts`

- [ ] **Step 1: Write the failing research-skill install tests**

In `packages/cli/src/setup-agents.test.ts`, update the first test to expect `ktx-research` entries. Replace the project-scoped assertions with:

```typescript
  it('plans project-scoped CLI and research files for every target', () => {
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'claude-code', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(tempDir, '.claude/skills/ktx-research/SKILL.md'), role: 'research-skill' },
      { kind: 'file', path: join(tempDir, '.claude/rules/ktx.md'), role: 'rule' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'codex', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx-research/SKILL.md'), role: 'research-skill' },
      { kind: 'file', path: join(tempDir, '.codex/instructions/ktx.md'), role: 'rule' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'cursor', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.cursor/rules/ktx.mdc') },
      { kind: 'file', path: join(tempDir, '.cursor/rules/ktx-research.mdc'), role: 'research-skill' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'opencode', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.opencode/commands/ktx.md') },
      { kind: 'file', path: join(tempDir, '.opencode/commands/ktx-research.md'), role: 'research-skill' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'universal', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md') },
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx-research/SKILL.md'), role: 'research-skill' },
    ]);
  });
```

Add this test after `installs target files, writes a manifest, and marks agents complete`:

```typescript
  it('installs the research skill from the runtime asset', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'universal',
          scope: 'project',
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const researchSkill = await readFile(join(tempDir, '.agents/skills/ktx-research/SKILL.md'), 'utf-8');
    expect(researchSkill).toContain('name: ktx-research');
    expect(researchSkill).toContain('Always run `discover_data` before writing SQL.');
    expect(researchSkill).toContain('Treat a `dictionary_search` miss as non-authoritative.');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts
```

Expected: FAIL because `plannedKtxAgentFiles()` does not return `ktx-research` entries and the installed research skill file does not exist.

- [ ] **Step 3: Add the research skill asset**

Create `packages/cli/src/skills/research/SKILL.md`:

```markdown
---
name: ktx-research
description: Use when answering a question that needs data from a KTX-connected database - investigating, analyzing, "how many", "show me", "what's the breakdown of", finding records by value, exploring tables, comparing periods, or any data-investigation request. Triggers even when the user does not say "research"; if the answer requires querying a configured KTX connection, this skill applies.
---

# KTX Research Workflow

You have access to KTX MCP tools for investigating data. Follow this workflow.

<workflow>
1. **Discover** - call `discover_data` first to see what exists across wiki, semantic-layer sources, and raw tables. Returns refs only.
2. **Inspect top hits in parallel** - for each promising ref:
   - `kind: 'wiki'` -> `wiki_read`
   - `kind: 'sl_source'`, `kind: 'sl_measure'`, or `kind: 'sl_dimension'` -> `sl_read_source`
   - `kind: 'table'` or `kind: 'column'` -> `entity_details`
3. **Resolve literals** - if the user named a value such as "Acme Corp" or "status=shipped", call `dictionary_search` to find which column holds it.
4. **Query** -
   - Prefer `sl_query` when the semantic layer covers the question.
   - Use `sql_execution` only for questions the semantic layer does not cover.
5. **Capture learnings** - at the end of the turn, call `memory_capture` so future turns benefit. Skip when the answer carries no durable knowledge.
</workflow>

<rules>
- Always run `discover_data` before writing SQL. Do not guess table names.
- Prefer the semantic layer over raw SQL when both can answer the question; measures are the source of truth.
- Read entity details before writing SQL against an unfamiliar table. Do not assume column names.
- Treat `sql_execution` as read-only. Writes are rejected by the server.
- Validate value mentions with `dictionary_search` instead of guessing case or spelling. Treat a `dictionary_search` miss as non-authoritative. The index is built from profile-sampled values, so a missing value may simply have been outside the sample. Follow up with `sql_execution` against the most plausible columns before concluding the value is absent.
</rules>

<examples>
**Input:** "How many orders did Acme Corp place last month?"

**Workflow:**
1. `dictionary_search({ values: ["Acme Corp"] })` finds `customers.name`.
2. `discover_data({ query: "orders customer monthly" })` finds an orders semantic-layer source.
3. `sl_read_source({ connectionId: "warehouse", sourceName: "orders_facts" })` confirms the source grain, measures, and dimensions.
4. `sl_query({ connectionId: "warehouse", measures: ["order_count"], filters: ["customer_name = 'Acme Corp'"] })` answers through the semantic layer.
5. `memory_capture({ userMessage, assistantMessage })` captures the durable finding.

---

**Input:** "What columns does the events table have?"

**Workflow:**
1. `discover_data({ query: "events table" })` returns a `table` ref.
2. `entity_details({ connectionId: "warehouse", entities: [{ table: "analytics.events" }] })` returns columns, types, and foreign keys.
3. Answer directly. No query is needed.
</examples>
```

- [ ] **Step 4: Copy skill assets during CLI build**

Create `packages/cli/scripts/copy-runtime-assets.mjs`:

```javascript
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const skillsSource = join(packageRoot, 'src', 'skills');
const skillsTarget = join(packageRoot, 'dist', 'skills');

await rm(skillsTarget, { recursive: true, force: true });
await mkdir(dirname(skillsTarget), { recursive: true });
await cp(skillsSource, skillsTarget, { recursive: true });
```

Modify `packages/cli/package.json`:

```json
"build": "node -e \"fs.rmSync('dist', { recursive: true, force: true })\" && tsc -p tsconfig.json && node scripts/copy-runtime-assets.mjs && node ../../scripts/prepare-cli-bin.mjs"
```

- [ ] **Step 5: Add research-skill install entries and content loading**

In `packages/cli/src/setup-agents.ts`, update the manifest entry role type:

```typescript
| { kind: 'file'; path: string; role?: 'skill' | 'rule' | 'research-skill' }
```

Add this helper near `ktxCliLauncher()`:

```typescript
async function readResearchSkillContent(): Promise<string> {
  const path = fileURLToPath(new URL('./skills/research/SKILL.md', import.meta.url));
  const content = await readFile(path, 'utf-8');
  return content.endsWith('\n') ? content : `${content}\n`;
}
```

Update `plannedKtxAgentFiles()` so every supported project target includes the `ktx-research` entry shown in Step 1. For global targets, return:

```typescript
if (input.scope === 'global') {
  if (input.target === 'claude-code') {
    const home = process.env.HOME ?? '';
    return [
      { kind: 'file', path: join(home, '.claude/skills/ktx/SKILL.md'), role: 'skill' as const },
      { kind: 'file', path: join(home, '.claude/skills/ktx-research/SKILL.md'), role: 'research-skill' as const },
      { kind: 'file', path: join(home, '.claude/rules/ktx.md'), role: 'rule' as const },
    ];
  }
  if (input.target === 'codex') {
    const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
    return [
      { kind: 'file', path: join(codexHome, 'skills/ktx/SKILL.md'), role: 'skill' as const },
      { kind: 'file', path: join(codexHome, 'skills/ktx-research/SKILL.md'), role: 'research-skill' as const },
      { kind: 'file', path: join(codexHome, 'instructions/ktx.md'), role: 'rule' as const },
    ];
  }
  if (input.target === 'cursor' || input.target === 'opencode') {
    return [];
  }
  throw new Error(`Global ${input.target} installation is not supported; omit --global.`);
}
```

In `installTarget()`, switch the file content selection to:

```typescript
const content =
  entry.role === 'rule'
    ? ruleInstructionContent({ projectDir: input.projectDir })
    : entry.role === 'research-skill'
      ? await readResearchSkillContent()
      : cliInstructionContent({ projectDir: input.projectDir, launcher });
```

- [ ] **Step 6: Run tests to verify the research skill passes**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts
```

Expected: PASS for the research skill install tests. MCP config tests are added in the next task and will fail until implemented.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/skills/research/SKILL.md packages/cli/scripts/copy-runtime-assets.mjs packages/cli/package.json packages/cli/src/setup-agents.ts packages/cli/src/setup-agents.test.ts
git commit -m "feat(cli): install KTX research skill"
```

## Task 2: Add MCP Client Config Planning And Rendering

**Files:**
- Modify: `packages/cli/src/setup-agents.test.ts`
- Modify: `packages/cli/src/setup-agents.ts`

- [ ] **Step 1: Write failing MCP config planner tests**

In `packages/cli/src/setup-agents.test.ts`, add these tests before `removes only manifest-listed files`:

```typescript
  it('writes Claude Code project MCP config and tracks the json key', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const mcpJson = JSON.parse(await readFile(join(tempDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { ktx: { type: string; url: string; headers?: Record<string, string> } };
    };
    expect(mcpJson.mcpServers.ktx).toEqual({ type: 'http', url: 'http://localhost:7878/mcp' });
    expect(await readKtxAgentInstallManifest(tempDir)).toMatchObject({
      entries: expect.arrayContaining([{ kind: 'json-key', path: join(tempDir, '.mcp.json'), jsonPath: ['mcpServers', 'ktx'] }]),
    });
    expect(io.stdout()).toContain('Run `ktx mcp start` to enable the configured KTX MCP server.');
  });

  it('writes Cursor project MCP config', async () => {
    const io = makeIo();

    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'cursor',
        scope: 'project',
        mode: 'cli',
        skipAgents: false,
      },
      io.io,
    );

    const cursorJson = JSON.parse(await readFile(join(tempDir, '.cursor/mcp.json'), 'utf-8')) as {
      mcpServers: { ktx: { url: string; headers?: Record<string, string> } };
    };
    expect(cursorJson.mcpServers.ktx).toEqual({ url: 'http://localhost:7878/mcp' });
  });

  it('prints Codex and opencode snippets without mutating printed-only config files', async () => {
    const codexIo = makeIo();
    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'codex',
        scope: 'project',
        mode: 'cli',
        skipAgents: false,
      },
      codexIo.io,
    );
    expect(codexIo.stdout()).toContain('[mcp_servers.ktx]');
    expect(codexIo.stdout()).toContain('url = "http://localhost:7878/mcp"');

    const opencodeIo = makeIo();
    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'opencode',
        scope: 'project',
        mode: 'cli',
        skipAgents: false,
      },
      opencodeIo.io,
    );
    expect(opencodeIo.stdout()).toContain('"mcp"');
    expect(opencodeIo.stdout()).toContain('"type": "remote"');
    await expect(readFile(join(tempDir, 'opencode.json'), 'utf-8')).rejects.toThrow();
  });

  it('uses MCP daemon state for port and token metadata without rendering literal tokens', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    await writeFile(
      join(tempDir, '.ktx/mcp.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          pid: 999999,
          host: '127.0.0.1',
          port: 8787,
          tokenAuth: true,
          projectDir: tempDir,
          startedAt: '2026-05-14T00:00:00.000Z',
          logPath: join(tempDir, '.ktx/logs/mcp.log'),
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    const io = makeIo();
    const previousToken = process.env.KTX_MCP_TOKEN;
    process.env.KTX_MCP_TOKEN = 'secret-token';

    try {
      await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
      );

      const rendered = JSON.stringify(JSON.parse(await readFile(join(tempDir, '.mcp.json'), 'utf-8')));
      expect(rendered).toContain('http://127.0.0.1:8787/mcp');
      expect(rendered).toContain('Bearer ${KTX_MCP_TOKEN}');
      expect(rendered).not.toContain('secret-token');
      expect(io.stdout()).toContain('Run `ktx mcp start` to enable the configured KTX MCP server.');
    } finally {
      process.env.KTX_MCP_TOKEN = previousToken;
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts
```

Expected: FAIL because no MCP config writer or snippet renderer exists.

- [ ] **Step 3: Add JSON helpers and MCP endpoint resolution**

In `packages/cli/src/setup-agents.ts`, add `existsSync` and `readKtxMcpDaemonStatus` imports:

```typescript
import { existsSync } from 'node:fs';
import { readKtxMcpDaemonStatus } from './managed-mcp-daemon.js';
```

Add these types and helpers after `type InstallEntry`:

```typescript
interface KtxMcpEndpointInfo {
  url: string;
  tokenAuth: boolean;
  running: boolean;
}

interface KtxMcpClientInstallResult {
  entries: InstallEntry[];
  snippets: string[];
  notices: string[];
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function objectAtPath(root: Record<string, unknown>, jsonPath: string[]): Record<string, unknown> {
  let cursor = root;
  for (const segment of jsonPath) {
    const current = cursor[segment];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  return cursor;
}

async function writeJsonKey(path: string, jsonPath: string[], value: unknown): Promise<void> {
  const root = await readJsonObject(path);
  const parent = objectAtPath(root, jsonPath.slice(0, -1));
  parent[jsonPath.at(-1) as string] = value;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, 'utf-8');
}

async function resolveMcpEndpoint(projectDir: string): Promise<KtxMcpEndpointInfo> {
  const status = await readKtxMcpDaemonStatus({ projectDir }).catch(() => null);
  if (status?.kind === 'running') {
    return {
      url: status.url,
      tokenAuth: status.state.tokenAuth,
      running: true,
    };
  }
  if (status?.kind === 'stale' && status.state) {
    return {
      url: `http://${status.state.host}:${status.state.port}/mcp`,
      tokenAuth: status.state.tokenAuth || Boolean(process.env.KTX_MCP_TOKEN),
      running: false,
    };
  }
  return {
    url: 'http://localhost:7878/mcp',
    tokenAuth: Boolean(process.env.KTX_MCP_TOKEN),
    running: false,
  };
}
```

- [ ] **Step 4: Add MCP entry renderers**

Add these helpers after `resolveMcpEndpoint()`:

```typescript
function tokenHeaders(endpoint: KtxMcpEndpointInfo): Record<string, string> | undefined {
  return endpoint.tokenAuth ? { Authorization: 'Bearer ${KTX_MCP_TOKEN}' } : undefined;
}

function claudeMcpEntry(endpoint: KtxMcpEndpointInfo): Record<string, unknown> {
  return {
    type: 'http',
    url: endpoint.url,
    ...(tokenHeaders(endpoint) ? { headers: tokenHeaders(endpoint) } : {}),
  };
}

function cursorMcpEntry(endpoint: KtxMcpEndpointInfo): Record<string, unknown> {
  return {
    url: endpoint.url,
    ...(tokenHeaders(endpoint) ? { headers: tokenHeaders(endpoint) } : {}),
  };
}

function codexSnippet(endpoint: KtxMcpEndpointInfo): string {
  if (endpoint.tokenAuth) {
    return [
      'Codex MCP config does not currently document HTTP headers.',
      'Run KTX on loopback without token auth for Codex, or configure headers after Codex documents support.',
    ].join('\n');
  }
  return [`[mcp_servers.ktx]`, `url = "${endpoint.url}"`].join('\n');
}

function opencodeSnippet(endpoint: KtxMcpEndpointInfo): string {
  return JSON.stringify(
    {
      mcp: {
        ktx: {
          type: 'remote',
          url: endpoint.url,
          enabled: true,
          ...(tokenHeaders(endpoint) ? { headers: tokenHeaders(endpoint) } : {}),
        },
      },
    },
    null,
    2,
  );
}

function claudeConfigPath(projectDir: string, scope: KtxAgentScope): { path: string; jsonPath: string[] } {
  const home = process.env.HOME ?? '';
  if (scope === 'global') {
    return { path: join(home, '.claude.json'), jsonPath: ['mcpServers', 'ktx'] };
  }
  if (scope === 'local') {
    return { path: join(home, '.claude.json'), jsonPath: ['projects', resolve(projectDir), 'mcpServers', 'ktx'] };
  }
  return { path: join(resolve(projectDir), '.mcp.json'), jsonPath: ['mcpServers', 'ktx'] };
}

function cursorConfigPath(projectDir: string, scope: KtxAgentScope): { path: string; jsonPath: string[] } {
  const home = process.env.HOME ?? '';
  return {
    path: scope === 'global' ? join(home, '.cursor/mcp.json') : join(resolve(projectDir), '.cursor/mcp.json'),
    jsonPath: ['mcpServers', 'ktx'],
  };
}
```

- [ ] **Step 5: Add the MCP client install planner**

Add this function after the snippet helpers:

```typescript
async function installMcpClientConfig(input: {
  projectDir: string;
  target: KtxAgentTarget;
  scope: KtxAgentScope;
}): Promise<KtxMcpClientInstallResult> {
  const endpoint = await resolveMcpEndpoint(input.projectDir);
  const entries: InstallEntry[] = [];
  const snippets: string[] = [];
  const notices: string[] = [];

  if (!endpoint.running) {
    notices.push('Run `ktx mcp start` to enable the configured KTX MCP server.');
  }

  if (input.target === 'claude-code') {
    const config = claudeConfigPath(input.projectDir, input.scope);
    await writeJsonKey(config.path, config.jsonPath, claudeMcpEntry(endpoint));
    entries.push({ kind: 'json-key', path: config.path, jsonPath: config.jsonPath });
  } else if (input.target === 'cursor') {
    const config = cursorConfigPath(input.projectDir, input.scope);
    await writeJsonKey(config.path, config.jsonPath, cursorMcpEntry(endpoint));
    entries.push({ kind: 'json-key', path: config.path, jsonPath: config.jsonPath });
  } else if (input.target === 'codex') {
    snippets.push(`Codex MCP snippet for ~/.codex/config.toml:\n${codexSnippet(endpoint)}`);
  } else if (input.target === 'opencode') {
    const path =
      input.scope === 'global' ? '~/.config/opencode/opencode.json' : `${relative(input.projectDir, join(input.projectDir, 'opencode.json'))}`;
    snippets.push(`opencode MCP snippet for ${path}:\n${opencodeSnippet(endpoint)}`);
  }

  return { entries, snippets, notices };
}
```

- [ ] **Step 6: Call the MCP planner during setup**

Keep `installTarget()` responsible only for writing agent files and returning those file entries.

In `runKtxSetupAgentsStep()`, replace the current install loop:

```typescript
    const entries: InstallEntry[] = [];
    for (const install of installs) entries.push(...(await installTarget({ projectDir: args.projectDir, ...install })));
```

with:

```typescript
    const entries: InstallEntry[] = [];
    const snippets: string[] = [];
    const notices = new Set<string>();
    for (const install of installs) {
      entries.push(...(await installTarget({ projectDir: args.projectDir, ...install })));
      const mcpResult = await installMcpClientConfig({ projectDir: args.projectDir, target: install.target, scope: install.scope });
      entries.push(...mcpResult.entries);
      for (const snippet of mcpResult.snippets) snippets.push(snippet);
      for (const notice of mcpResult.notices) notices.add(notice);
    }
```

After the install summary write:

```typescript
    for (const snippet of snippets) {
      io.stdout.write(`\n${snippet}\n`);
    }
    for (const notice of notices) {
      io.stdout.write(`\n${notice}\n`);
    }
```

- [ ] **Step 7: Run tests to verify MCP config passes**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts
```

Expected: PASS for research-skill and MCP config tests.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/setup-agents.ts packages/cli/src/setup-agents.test.ts
git commit -m "feat(cli): configure MCP clients in setup agents"
```

## Task 3: Add Claude Local Scope

**Files:**
- Modify: `packages/cli/src/commands/setup-commands.ts`
- Modify: `packages/cli/src/setup-agents.ts`
- Modify: `packages/cli/src/setup-agents.test.ts`
- Modify: `packages/cli/src/setup.test.ts`
- Modify: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Write failing local-scope tests**

Add this test to `packages/cli/src/setup-agents.test.ts`:

```typescript
  it('writes Claude Code local MCP config under the project key in ~/.claude.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const io = makeIo();
      await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'local',
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
      );

      const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf-8')) as {
        projects: Record<string, { mcpServers: { ktx: { type: string; url: string } } }>;
      };
      expect(config.projects[tempDir].mcpServers.ktx).toEqual({ type: 'http', url: 'http://localhost:7878/mcp' });
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
```

Add these command-level tests after the existing `dispatches setup agent flags` test in `packages/cli/src/index.test.ts`:

```typescript
  it('rejects --local with non-Claude targets', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'cursor', '--local', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setupIo.stderr()).toContain('--local is only supported with --target claude-code');
    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects --local and --global together', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'claude-code', '--local', '--global', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setupIo.stderr()).toContain('Choose only one agent scope: --local or --global.');
    expect(setup).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts src/index.test.ts
```

Expected: FAIL because `KtxAgentScope` does not include `local` and the setup command has no `--local` option.

- [ ] **Step 3: Add the local scope type and command option**

In `packages/cli/src/setup-agents.ts`, change:

```typescript
export type KtxAgentScope = 'project' | 'global';
```

to:

```typescript
export type KtxAgentScope = 'project' | 'global' | 'local';
```

In `packages/cli/src/commands/setup-commands.ts`, add `local` to `isOnlyAgentOptions()`:

```typescript
'local',
```

Add the command option after `--global`:

```typescript
.option('--local', 'Install Claude Code MCP config into the private per-project ~/.claude.json scope', false)
```

In the setup action before `const mode = ...`, add:

```typescript
    if (options.local && options.global) {
      context.io.stderr.write('Choose only one agent scope: --local or --global.\n');
      context.setExitCode(1);
      return;
    }
    if (options.local && options.target && options.target !== 'claude-code') {
      context.io.stderr.write('--local is only supported with --target claude-code.\n');
      context.setExitCode(1);
      return;
    }
```

Replace:

```typescript
const resolvedAgentScope = options.global ? 'global' : 'project';
```

with:

```typescript
const resolvedAgentScope = options.local ? 'local' : options.global ? 'global' : 'project';
```

- [ ] **Step 4: Run local-scope tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts src/index.test.ts
```

Expected: PASS for the new local-scope coverage.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/setup-commands.ts packages/cli/src/setup-agents.ts packages/cli/src/setup-agents.test.ts packages/cli/src/setup.test.ts packages/cli/src/index.test.ts
git commit -m "feat(cli): support Claude local MCP setup scope"
```

## Task 4: Final Verification

**Files:**
- Verify all files changed in Tasks 1-3.

- [ ] **Step 1: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts src/commands/mcp-commands.test.ts src/mcp-http-server.test.ts src/managed-mcp-daemon.test.ts
```

Expected: all selected test files pass.

- [ ] **Step 2: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: TypeScript completes with no errors.

- [ ] **Step 3: Run CLI build**

Run:

```bash
pnpm --filter @ktx/cli run build
```

Expected: build succeeds and `packages/cli/dist/skills/research/SKILL.md` exists.

- [ ] **Step 4: Run dead-code check for the changed TypeScript surface**

Run:

```bash
pnpm run dead-code
```

Expected: Biome and Knip complete with no new findings from the setup-agent changes.

- [ ] **Step 5: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intended setup-agent, skill asset, package script, and test files are modified.

## Self-Review

Spec coverage:

- Covers `ktx-research` skill installation paths for Claude Code, Codex, Cursor, opencode, and universal project targets.
- Covers Claude Code and Cursor JSON MCP writers.
- Covers Codex and opencode printed snippets.
- Covers token handling with `${KTX_MCP_TOKEN}` and no literal token rendering.
- Covers `.ktx/mcp.json` port selection and daemon-start hint.
- Covers manifest tracking for written JSON keys and removal through existing `json-key` cleanup.

Known v1 gap not covered by this plan:

- Ingest warehouse-verification contract convergence from `connectionName` to `connectionId`, shared service extraction, and caller/test updates remains v1-blocking and needs its own focused plan after this setup-agent slice lands.
