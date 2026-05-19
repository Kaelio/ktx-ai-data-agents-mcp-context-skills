# KTX Setup Agents Output Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ktx setup --agents` print the polished interactive hint,
per-install inline summaries, the required next-actions note, and the final
`All set.` outro described by the May 19 output-polish spec.

**Architecture:** Keep the change centered in
`packages/cli/src/setup-agents.ts` and preserve the existing
`withMultiselectNavigation` helper for other setup flows. Replace the old
boxed install-summary string with structured summary entries, then render those
entries with Clack `log.step` for real TTY output and plain `io.stdout` text in
tests or scripted output. The current uncommitted Claude Desktop split-ZIP
changes are treated as the baseline and must not be reverted.

**Tech Stack:** TypeScript, Vitest, Node stream types, `@clack/prompts`,
pnpm workspace commands.

---

## Current audit

Original spec:
`docs/superpowers/specs/2026-05-19-ktx-setup-agents-output-polish-design.md`

Current uncommitted files:

- `README.md`
- `docs-site/content/docs/integrations/agent-clients.mdx`
- `packages/cli/src/setup-agents.test.ts`
- `packages/cli/src/setup-agents.ts`

Observed implementation status:

- The branch currently contains unrelated Claude Desktop split-ZIP work:
  `ktx-analytics.zip` and optional `ktx.zip` replace the old combined
  `ktx-skills.zip`. Keep that work intact.
- `packages/cli/src/setup-agents.ts` still imports and uses
  `withMultiselectNavigation` for the agents multiselect prompt.
- `runKtxSetupAgentsStep` does not emit
  `Space to select, Enter to confirm, Esc to go back.` before interactive
  prompts.
- `formatInstallSummary` still returns one boxed string containing
  `KTX project`, `Installed agents`, and nested indentation.
- `runKtxSetupAgentsStep` still prints the install summary with
  `setupUi.note(..., 'Agent integration complete', io)`.
- `runKtxSetupAgentsStep` does not emit `outro('All set.')` after the
  "Required before using agents" note.
- Tests still assert the old long multiselect message and old boxed install
  summary.

V1-blocking gaps:

- Move the multiselect navigation hint out of the question text and print it
  once before interactive prompts.
- Render install summaries as inline `log.step` blocks, one block per install.
- Keep the next-actions note boxed and emit `All set.` only when next-actions
  are shown.
- Update setup-agents tests to cover the new output contract.

Non-blocking gaps:

- The docs updates for Claude Desktop split ZIPs are outside this output-polish
  spec and are already present in the current working tree.
- `setup --sources` and `setup --databases` still use
  `withMultiselectNavigation`; the spec explicitly defers those flows.
- There is no docs-site update for the output shape because no public docs page
  currently promises the old boxed install-summary layout.

## File structure

Modify:

- `packages/cli/src/setup-agents.ts`
  - Remove the agents-flow dependency on `withMultiselectNavigation`.
  - Add tiny output helpers that use Clack `log.info`, `log.step`, and `outro`
    when `io.stdout` is a writable TTY and fall back to plain writes otherwise.
  - Rename `formatInstallSummary` to `formatInstallSummaryLines` and return
    structured entries.
  - Render each summary entry with `log.step`.
  - Emit the final outro only when next-actions are printed.
- `packages/cli/src/setup-agents.test.ts`
  - Import `formatInstallSummaryLines`.
  - Update the four output-polish tests named in the spec.
  - Add or update assertions for the single hint line and final outro.

Do not modify:

- `packages/cli/src/prompt-navigation.ts`
- `packages/cli/src/prompt-navigation.test.ts`
- `README.md`
- `docs-site/content/docs/integrations/agent-clients.mdx`

## Task 1: Move the interactive multiselect hint out of the prompt

**Files:**

- Modify: `packages/cli/src/setup-agents.test.ts`
- Modify: `packages/cli/src/setup-agents.ts`

- [ ] **Step 1: Write the failing prompt-output test**

In `packages/cli/src/setup-agents.test.ts`, replace the existing test named
`explains how to select multiple agent targets in interactive mode` with:

```typescript
  it('prints one navigation hint before interactive agent target prompts', async () => {
    const io = makeIo();
    const prompts = {
      select: vi.fn(async () => 'mcp-cli'),
      multiselect: vi.fn(async () => ['back']),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
        { prompts },
      ),
    ).resolves.toEqual({ status: 'back', projectDir: tempDir });

    expect(io.stdout()).toContain('Space to select, Enter to confirm, Esc to go back.');
    expect(io.stdout().match(/Space to select/g)).toHaveLength(1);
    expect(prompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Which agent targets should KTX install?',
      }),
    );
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts -t "prints one navigation hint before interactive agent target prompts"
```

Expected: FAIL because the current implementation embeds the long navigation
hint in the multiselect message and does not write the short hint to
`io.stdout`.

- [ ] **Step 3: Add Clack output helpers for setup-agents**

In `packages/cli/src/setup-agents.ts`, replace the current top imports:

```typescript
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
```

with:

```typescript
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { log, outro } from '@clack/prompts';
```

Remove this import:

```typescript
import { withMultiselectNavigation } from './prompt-navigation.js';
```

Add these helpers after the `KtxCliLauncher` interface:

```typescript
function isWritableTtyOutput(output: KtxCliIo['stdout']): output is KtxCliIo['stdout'] & Writable {
  return (
    output.isTTY === true &&
    typeof (output as { on?: unknown }).on === 'function' &&
    typeof (output as { columns?: unknown }).columns !== 'undefined'
  );
}

function writeSetupInfo(io: KtxCliIo, message: string): void {
  if (isWritableTtyOutput(io.stdout)) {
    log.info(message, { output: io.stdout });
    return;
  }
  io.stdout.write(`${message}\n`);
}

function writeSetupStep(io: KtxCliIo, message: string): void {
  if (isWritableTtyOutput(io.stdout)) {
    log.step(message, { output: io.stdout });
    return;
  }
  io.stdout.write(`\n${message}\n`);
}

function writeSetupOutro(io: KtxCliIo, message: string): void {
  if (isWritableTtyOutput(io.stdout)) {
    outro(message, { output: io.stdout });
    return;
  }
  io.stdout.write(`\n${message}\n`);
}
```

- [ ] **Step 4: Print the short hint only before interactive prompts**

In `runKtxSetupAgentsStep`, immediately after:

```typescript
  const prompts = deps.prompts ?? createPromptAdapter();
```

add:

```typescript
  if (args.inputMode === 'auto' && args.target === undefined) {
    writeSetupInfo(io, 'Space to select, Enter to confirm, Esc to go back.');
  }
```

In the multiselect call, replace:

```typescript
            message: withMultiselectNavigation('Which agent targets should KTX install?'),
```

with:

```typescript
            message: 'Which agent targets should KTX install?',
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts -t "prints one navigation hint before interactive agent target prompts"
```

Expected: PASS.

## Task 2: Return structured install-summary entries

**Files:**

- Modify: `packages/cli/src/setup-agents.test.ts`
- Modify: `packages/cli/src/setup-agents.ts`

- [ ] **Step 1: Update the summary formatter import in tests**

In `packages/cli/src/setup-agents.test.ts`, replace:

```typescript
  formatInstallSummary,
```

with:

```typescript
  formatInstallSummaryLines,
```

- [ ] **Step 2: Write failing structured formatter tests**

In `packages/cli/src/setup-agents.test.ts`, replace the test named
`formats summary with explicit project-scoped config paths` with:

```typescript
  it('formats summary with explicit project-scoped config paths', () => {
    const summary = formatInstallSummaryLines(
      [{ target: 'cursor', scope: 'project', mode: 'mcp-cli' }],
      [
        { kind: 'file', path: join(tempDir, '.cursor/rules/ktx-analytics.mdc'), role: 'analytics-skill' },
        { kind: 'file', path: join(tempDir, '.cursor/rules/ktx.mdc') },
        { kind: 'json-key', path: join(tempDir, '.cursor/mcp.json'), jsonPath: ['mcpServers', 'ktx'] },
      ],
      tempDir,
    );

    expect(summary).toEqual([
      {
        title: 'Cursor · Project scope',
        lines: [
          join(tempDir, '.cursor/mcp.json'),
          'Requires MCP to be started.',
          'Cursor rules installed.',
        ],
      },
    ]);
  });
```

Replace the test named `formats summary with multiple agent targets` with:

```typescript
  it('formats summary with multiple agent targets', () => {
    const summary = formatInstallSummaryLines(
      [
        { target: 'claude-code', scope: 'project', mode: 'mcp-cli' },
        { target: 'codex', scope: 'project', mode: 'mcp-cli' },
      ],
      [
        { kind: 'file', path: join(tempDir, '.claude/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
        { kind: 'file', path: join(tempDir, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
        { kind: 'file', path: join(tempDir, '.claude/rules/ktx.md'), role: 'rule' },
        { kind: 'json-key', path: join(tempDir, '.mcp.json'), jsonPath: ['mcpServers', 'ktx'] },
        { kind: 'file', path: join(tempDir, '.agents/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
        { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
        { kind: 'file', path: join(tempDir, '.codex/instructions/ktx.md'), role: 'rule' },
      ],
      tempDir,
    );

    expect(summary).toEqual([
      {
        title: 'Claude Code · Project scope',
        lines: [
          join(tempDir, '.mcp.json'),
          'Requires MCP to be started.',
          'Analytics skill installed.',
          'Admin CLI skill installed.',
        ],
      },
      {
        title: 'Codex · Project scope',
        lines: [
          'Add the snippet shown below to ~/.codex/config.toml.',
          'Requires MCP to be started.',
          'Codex guidance installed.',
        ],
      },
    ]);
  });
```

- [ ] **Step 3: Run the focused formatter tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts -t "formats summary"
```

Expected: FAIL because `formatInstallSummaryLines` is not exported and the
current formatter returns one string.

- [ ] **Step 4: Replace the string summary formatter with structured entries**

In `packages/cli/src/setup-agents.ts`, add this exported interface immediately
before the current `formatInstallSummary` function:

```typescript
export interface InstallSummaryEntry {
  title: string;
  lines: string[];
}
```

Replace the full `export function formatInstallSummary(...)` implementation
with:

```typescript
function formatInlinePath(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  const resolvedHome = resolve(home);
  if (path === resolvedHome) return '~';
  if (path.startsWith(`${resolvedHome}/`)) {
    return `~/${relative(resolvedHome, path)}`;
  }
  return path;
}

export function formatInstallSummaryLines(
  installs: Array<{ target: KtxAgentTarget; scope: KtxAgentScope; mode: KtxAgentInstallMode }>,
  entries: InstallEntry[],
  projectDir: string,
): InstallSummaryEntry[] {
  const entriesByTarget = new Map<KtxAgentTarget, InstallEntry[]>();
  for (const install of installs) {
    const plannedFilePaths = new Set(
      plannedKtxAgentFiles({ projectDir, ...install })
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.path),
    );
    entriesByTarget.set(
      install.target,
      entries.filter((entry) => entry.kind === 'file' && plannedFilePaths.has(entry.path)),
    );
  }

  const mcpEntriesByTarget = new Map<KtxAgentTarget, InstallEntry[]>();
  for (const install of installs) {
    const plannedMcpKeys = new Set(plannedMcpJsonEntries({ projectDir, ...install }).map(entryKey));
    mcpEntriesByTarget.set(
      install.target,
      entries.filter((entry) => entry.kind === 'json-key' && plannedMcpKeys.has(entryKey(entry))),
    );
  }

  return installs.map((install) => {
    const targetEntries = entriesByTarget.get(install.target) ?? [];
    const mcpEntry = mcpEntriesByTarget
      .get(install.target)
      ?.find((entry): entry is Extract<InstallEntry, { kind: 'json-key' }> => entry.kind === 'json-key');
    const lines: string[] = [];

    if (mcpEntry) {
      lines.push(formatInlinePath(mcpEntry.path));
    } else if (install.target !== 'claude-desktop') {
      lines.push(manualMcpConfigInstruction(install.target, install.scope));
    }

    if (targetUsesHttpMcpDaemon(install.target)) {
      lines.push('Requires MCP to be started.');
    }

    const hasAnalytics = hasEntryRole(targetEntries, 'analytics-skill');
    const hasAdmin = hasAdminCliEntries(targetEntries);
    const claudeDesktopSkillBundles = targetEntries.filter(
      (entry): entry is Extract<InstallEntry, { kind: 'file' }> =>
        entry.kind === 'file' && entry.role === 'claude-desktop-skill-bundle',
    );

    if (install.target === 'claude-code') {
      if (hasAnalytics) {
        lines.push('Analytics skill installed.');
      }
      if (hasAdmin) {
        lines.push('Admin CLI skill installed.');
      }
    } else if (install.target === 'claude-desktop') {
      if (claudeDesktopSkillBundles.length > 0) {
        lines.push('Skill bundles:');
        for (const bundle of claudeDesktopSkillBundles) {
          lines.push(`  ${bundle.path}`);
        }
      }
    } else if (hasAnalytics || hasAdmin) {
      lines.push(`${guidanceInstallLine(install.target)}.`);
    }

    if (hasEntryRole(targetEntries, 'launcher')) {
      lines.push('Starts KTX over stdio from Claude Desktop.');
    }

    return {
      title: `${targetDisplayName(install.target)} · ${scopeDisplayName(install.scope)}`,
      lines,
    };
  });
}
```

- [ ] **Step 5: Run the focused formatter tests and verify they pass**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts -t "formats summary"
```

Expected: PASS.

## Task 3: Render inline install summaries with `log.step`

**Files:**

- Modify: `packages/cli/src/setup-agents.test.ts`
- Modify: `packages/cli/src/setup-agents.ts`

- [ ] **Step 1: Write failing install-summary output assertions**

In `packages/cli/src/setup-agents.test.ts`, replace the body of the test named
`prints per-agent install summary after successful installation` with:

```typescript
    const io = makeIo();

    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'claude-code',
        scope: 'project',
        mode: 'mcp-cli',
        skipAgents: false,
      },
      io.io,
    );

    const output = io.stdout();
    expect(output).toContain('Claude Code · Project scope');
    expect(output).toContain(join(tempDir, '.mcp.json'));
    expect(output).toContain('Requires MCP to be started.');
    expect(output).toContain('Analytics skill installed.');
    expect(output).toContain('Admin CLI skill installed.');
    expect(output).not.toContain('Agent integration complete');
    expect(output).not.toContain(`KTX project\n  ${tempDir}`);
    expect(output).not.toContain('Installed agents');
    expect(output).not.toContain('.claude/skills/ktx-analytics/SKILL.md');
    expect(output).not.toContain('.claude/skills/ktx/SKILL.md');
    expect(output).not.toContain('.claude/rules/ktx.md');
```

In the test named `can return agent next actions without printing them`, replace:

```typescript
    expect(io.stdout()).toContain('Agent integration complete');
    expect(io.stdout()).not.toContain('Required before using agents');
```

with:

```typescript
    expect(io.stdout()).toContain('Claude Code · Project scope');
    expect(io.stdout()).not.toContain('Agent integration complete');
    expect(io.stdout()).not.toContain('Required before using agents');
    expect(io.stdout()).not.toContain('All set.');
```

- [ ] **Step 2: Run the focused output tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts -t "install summary|without printing"
```

Expected: FAIL because `Agent integration complete` is still printed and the
new inline summary heading is absent.

- [ ] **Step 3: Render each structured summary as an inline step**

In `runKtxSetupAgentsStep`, replace:

```typescript
    setupUi.note(
      formatInstallSummary(installs, entries, args.projectDir),
      'Agent integration complete',
      io,
    );
```

with:

```typescript
    for (const summary of formatInstallSummaryLines(installs, entries, args.projectDir)) {
      writeSetupStep(
        io,
        summary.lines.length > 0 ? `${summary.title}\n${summary.lines.join('\n')}` : summary.title,
      );
    }
```

- [ ] **Step 4: Run the focused output tests and verify they pass**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts -t "install summary|without printing"
```

Expected: PASS.

## Task 4: Emit the final outro after next actions

**Files:**

- Modify: `packages/cli/src/setup-agents.test.ts`
- Modify: `packages/cli/src/setup-agents.ts`

- [ ] **Step 1: Add failing outro assertions**

In `packages/cli/src/setup-agents.test.ts`, in the test named
`prints standalone agent next actions after successful installation`, add this
assertion after the existing next-actions stdout assertions:

```typescript
    expect(io.stdout()).toContain('All set.');
```

In the test named `prints one target-aware next actions block for mixed agent
targets`, add this assertion near the other stdout assertions:

```typescript
      expect(output).toContain('All set.');
```

- [ ] **Step 2: Run the focused next-actions tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts -t "next actions|All set|without printing"
```

Expected: FAIL because no outro is emitted.

- [ ] **Step 3: Emit `All set.` only when next-actions are shown**

In `runKtxSetupAgentsStep`, replace:

```typescript
    if (args.showNextActions !== false) {
      setupUi.note(nextActions, 'Required before using agents', io, { format: (line) => line });
    }
```

with:

```typescript
    if (args.showNextActions !== false) {
      setupUi.note(nextActions, 'Required before using agents', io, { format: (line) => line });
      writeSetupOutro(io, 'All set.');
    }
```

- [ ] **Step 4: Run the focused next-actions tests and verify they pass**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts -t "next actions|All set|without printing"
```

Expected: PASS.

## Task 5: Verify the full CLI package surface

**Files:**

- Verify: `packages/cli/src/setup-agents.ts`
- Verify: `packages/cli/src/setup-agents.test.ts`

- [ ] **Step 1: Run the setup-agents test file**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Run the CLI test script**

Run:

```bash
pnpm --filter @ktx/cli run test
```

Expected: PASS.

- [ ] **Step 4: Run dead-code checks for TypeScript changes**

Run:

```bash
pnpm run dead-code
```

Expected: PASS. If Knip reports unrelated existing findings, inspect them and
record the exact unrelated findings before finishing.

- [ ] **Step 5: Run pre-commit for modified TypeScript files**

Run:

```bash
uv run pre-commit run --files packages/cli/src/setup-agents.ts packages/cli/src/setup-agents.test.ts
```

Expected: PASS. If the repository has no usable pre-commit environment or the
configured tool versions are unavailable, state the exact failure and keep the
passing pnpm checks as the closest available verification.

- [ ] **Step 6: Inspect the final diff**

Run:

```bash
git diff -- packages/cli/src/setup-agents.ts packages/cli/src/setup-agents.test.ts
```

Expected: The diff only contains output-polish changes on top of the existing
Claude Desktop split-ZIP baseline. It must not revert the current
`ktx-analytics.zip` and `ktx.zip` behavior.

## Self-review checklist

- The agents multiselect message is exactly
  `Which agent targets should KTX install?`.
- The short navigation hint appears once for interactive no-target runs and not
  for scripted target runs.
- The shared `withMultiselectNavigation` helper and its tests are unchanged.
- `Agent integration complete`, `KTX project`, and `Installed agents` no longer
  appear in setup-agents install-summary output.
- `Required before using agents` remains a `note()` box.
- `All set.` appears only when the next-actions note is printed.
- Current uncommitted README and docs-site split-ZIP edits are untouched.
