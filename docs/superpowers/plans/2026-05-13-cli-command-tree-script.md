# CLI Command-Tree Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a build-time script that prints the full `ktx` CLI command tree (name, aliases, description per node) as an indented text tree, for docs and discovery — without adding a runtime `ktx` subcommand.

**Architecture:** Commander.js exposes every registered command as a `Command` instance with `.commands`, `.name()`, `.aliases()`, `.description()` — we walk that tree. The current `runCommanderKtxCli` in `packages/cli/src/cli-program.ts` builds the program inline; we extract that assembly into a pure `buildKtxProgram(...)` helper that any caller can use to materialize the configured root `Command` without parsing argv. A new pure module `command-tree.ts` walks the `Command` into plain data and renders it as indented text. A new TypeScript entrypoint `print-command-tree.ts` compiles alongside `bin.ts` into `dist/print-command-tree.js`, instantiates the program with stub IO/deps, and writes the rendered tree to stdout. A pnpm script under `@ktx/cli` exposes it as `pnpm --filter @ktx/cli run docs:commands`.

**Tech Stack:** TypeScript (NodeNext ESM), Node 22, Commander 14 via `@commander-js/extra-typings`, vitest 4.

---

## File Map

- **Modify:** `packages/cli/src/cli-program.ts` — extract `buildKtxProgram` from `runCommanderKtxCli`.
- **Create:** `packages/cli/src/cli-program.test.ts` — vitest tests for the new helper.
- **Create:** `packages/cli/src/command-tree.ts` — pure `walkCommandTree` + `formatCommandTree`.
- **Create:** `packages/cli/src/command-tree.test.ts` — vitest tests against ad-hoc Command trees.
- **Create:** `packages/cli/src/print-command-tree.ts` — script entrypoint; thin glue.
- **Create:** `packages/cli/src/print-command-tree.test.ts` — vitest test that calls the script's exported `main()` with a fake stdout and asserts the rendered tree includes known top-level commands.
- **Modify:** `packages/cli/package.json` — add `docs:commands` script and include the new entry in tsc build output (no change needed if `tsconfig` already globs `src/**/*.ts`, but verify).
- **Modify:** `packages/cli/README.md` (if it exists; otherwise skip) — document `pnpm run docs:commands`.

Files that change together (cli-program + its test, command-tree + its test, print-command-tree + its test) live next to each other under `packages/cli/src/`, matching the existing convention (e.g. `bin.ts`, `cli-runtime.ts`, `runtime.ts` + `runtime.test.ts`).

---

## Task 1: Extract `buildKtxProgram` from `runCommanderKtxCli`

Refactor only — no behavior change. The current code in `cli-program.ts` interleaves program construction with `parseAsync` dispatch. Splitting them lets the new script reuse construction without invoking the CLI.

**Files:**
- Modify: `packages/cli/src/cli-program.ts:197-275` (function `runCommanderKtxCli`)
- Create: `packages/cli/src/cli-program.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/cli-program.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { Command } from '@commander-js/extra-typings';
import { buildKtxProgram } from './cli-program.js';
import type { KtxCliIo, KtxCliPackageInfo } from './cli-runtime.js';

function stubIo(): KtxCliIo {
  return {
    stdout: { isTTY: false, columns: 80, write: () => {} },
    stderr: { write: () => {} },
  };
}

function stubPackageInfo(): KtxCliPackageInfo {
  return { name: '@ktx/cli', version: '0.0.0-test', contextPackageName: '@ktx/context' };
}

describe('buildKtxProgram', () => {
  it('returns a Command named "ktx" with all registered top-level subcommands', () => {
    const program: Command = buildKtxProgram({
      io: stubIo(),
      deps: {},
      packageInfo: stubPackageInfo(),
      runInit: async () => 0,
    });

    expect(program.name()).toBe('ktx');
    const topLevel = program.commands.map((c) => c.name()).sort();
    // Sanity check: at least these registrar surfaces must be present.
    for (const expected of ['setup', 'serve', 'sl', 'dev']) {
      expect(topLevel).toContain(expected);
    }
  });

  it('does not parse argv or invoke action handlers', async () => {
    // Build should be a pure call; no rejections, no side-effects to stdout.
    let wrote = '';
    const io: KtxCliIo = {
      stdout: { isTTY: false, columns: 80, write: (chunk) => { wrote += chunk; } },
      stderr: { write: (chunk) => { wrote += chunk; } },
    };
    buildKtxProgram({ io, deps: {}, packageInfo: stubPackageInfo(), runInit: async () => 0 });
    expect(wrote).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ktx/cli exec vitest run src/cli-program.test.ts`

Expected: FAIL — `buildKtxProgram is not exported from './cli-program.js'` (or similar TS/ESM error).

- [ ] **Step 3: Extract `buildKtxProgram` from `runCommanderKtxCli`**

Edit `packages/cli/src/cli-program.ts`. Add a new exported function above `runCommanderKtxCli`:

```typescript
export interface BuildKtxProgramOptions {
  io: KtxCliIo;
  deps: KtxCliDeps;
  packageInfo: KtxCliPackageInfo;
  runInit: (args: { projectDir: string; projectName?: string; force: boolean }, io: KtxCliIo) => Promise<number>;
  setExitCode?: (code: number) => void;
}

export function buildKtxProgram(options: BuildKtxProgramOptions): Command {
  const program = createBaseProgram(options.packageInfo, options.io);
  const context: KtxCliCommandContext = {
    io: options.io,
    deps: options.deps,
    packageInfo: options.packageInfo,
    setExitCode: options.setExitCode ?? (() => {}),
    runInit: options.runInit,
    writeDebug: (command, commandContext) => {
      writeDebug(options.io, commandContext, command);
    },
  };

  registerSetupCommands(program, context);
  registerConnectionCommands(program, context);
  registerPublicIngestCommands(program, context);
  registerWikiCommands(program, context);
  registerSlCommands(program, context);
  registerRuntimeCommands(program, context);
  registerServeCommands(program, context);
  registerStatusCommands(program, context);
  registerAgentCommands(program, context);
  registerDevCommands(program, context);

  return program;
}
```

Then rewrite the body of `runCommanderKtxCli` (lines 197-275) to delegate program assembly. Replace the block from `const program = createBaseProgram(info, io);` (line 206) through `registerDevCommands(program, context);` (line 248) with:

```typescript
  profileMark('commander:entry');
  let exitCode = 0;
  const program = buildKtxProgram({
    io,
    deps,
    packageInfo: info,
    runInit: options.runInit,
    setExitCode: (code: number) => {
      exitCode = code;
    },
  });
  profileMark('commander:program-built');
  const context: KtxCliCommandContext = {
    io,
    deps,
    packageInfo: info,
    setExitCode: (code: number) => {
      exitCode = code;
    },
    runInit: options.runInit,
    writeDebug: (command: string, commandContext: CommandWithGlobalOptions) => {
      writeDebug(io, commandContext, command);
    },
  };
```

Keep the `context` re-declaration only if subsequent code (the `if (argv.length === 0)` branch that calls `runBareInteractiveCommand(program, io, context)`) still needs it. It does — `runBareInteractiveCommand` consumes `context`. Keep `context` exactly as it was after the deletion; do not change `runBareInteractiveCommand`'s signature or behavior. Drop the now-removed individual `register*` calls and their `profileMark` lines from `runCommanderKtxCli`.

- [ ] **Step 4: Run the new test to verify it passes**

Run: `pnpm --filter @ktx/cli exec vitest run src/cli-program.test.ts`

Expected: PASS — both `it` blocks green.

- [ ] **Step 5: Run the full CLI test suite to confirm no regression**

Run: `pnpm --filter @ktx/cli run test 2>&1 | tee /tmp/ktx-cli-test-output.log`

Expected: PASS overall. Inspect the log if any previously-passing test now fails — most likely a missing register call (compare to lines 221-249 of the pre-change file).

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @ktx/cli run type-check`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/cli-program.ts packages/cli/src/cli-program.test.ts
git commit -m "refactor(cli): extract buildKtxProgram for reuse outside runCommanderKtxCli"
```

---

## Task 2: Pure tree walker `walkCommandTree`

Take a Commander `Command` and produce plain data: `{ name, description, aliases, children }`. No formatting yet. Pure function — depends only on the public `Command` API.

**Files:**
- Create: `packages/cli/src/command-tree.ts`
- Create: `packages/cli/src/command-tree.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/command-tree.test.ts`:

```typescript
import { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { walkCommandTree } from './command-tree.js';

describe('walkCommandTree', () => {
  it('captures name, description, aliases, and nested children', () => {
    const root = new Command('root').description('the root');
    const child = new Command('child').description('a child').alias('c').alias('ch');
    const grandchild = new Command('grand').description('a grandchild');
    child.addCommand(grandchild);
    root.addCommand(child);

    const tree = walkCommandTree(root);

    expect(tree).toEqual({
      name: 'root',
      description: 'the root',
      aliases: [],
      children: [
        {
          name: 'child',
          description: 'a child',
          aliases: ['c', 'ch'],
          children: [
            { name: 'grand', description: 'a grandchild', aliases: [], children: [] },
          ],
        },
      ],
    });
  });

  it('returns an empty children array when there are no subcommands', () => {
    const leaf = new Command('leaf').description('alone');
    expect(walkCommandTree(leaf)).toEqual({
      name: 'leaf',
      description: 'alone',
      aliases: [],
      children: [],
    });
  });

  it('uses an empty string when description is unset', () => {
    const cmd = new Command('bare');
    expect(walkCommandTree(cmd).description).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ktx/cli exec vitest run src/command-tree.test.ts`

Expected: FAIL — `walkCommandTree` cannot be resolved.

- [ ] **Step 3: Implement `walkCommandTree`**

Create `packages/cli/src/command-tree.ts`:

```typescript
import type { Command } from '@commander-js/extra-typings';

export interface CommandTreeNode {
  name: string;
  description: string;
  aliases: string[];
  children: CommandTreeNode[];
}

export function walkCommandTree(command: Command): CommandTreeNode {
  return {
    name: command.name(),
    description: command.description(),
    aliases: command.aliases(),
    children: command.commands.map((child) => walkCommandTree(child as Command)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ktx/cli exec vitest run src/command-tree.test.ts`

Expected: PASS (3 of 3).

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @ktx/cli run type-check`

Expected: no errors.

---

## Task 3: Indented-text renderer `formatCommandTree`

Render a `CommandTreeNode` as plain text. Each node on its own line: `<indent><name>[ (alias1, alias2)][ — description]`. Indent is two spaces per depth level. Children sorted alphabetically by name to keep output stable across changes that reorder registrar calls.

**Files:**
- Modify: `packages/cli/src/command-tree.ts`
- Modify: `packages/cli/src/command-tree.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/src/command-tree.test.ts`:

```typescript
import { formatCommandTree } from './command-tree.js';

describe('formatCommandTree', () => {
  it('renders a single node with no children', () => {
    const node = { name: 'solo', description: 'just me', aliases: [], children: [] };
    expect(formatCommandTree(node)).toBe('solo — just me\n');
  });

  it('renders aliases in parentheses before the description', () => {
    const node = { name: 'cmd', description: 'does things', aliases: ['c', 'co'], children: [] };
    expect(formatCommandTree(node)).toBe('cmd (c, co) — does things\n');
  });

  it('omits the dash when description is empty', () => {
    const node = { name: 'bare', description: '', aliases: [], children: [] };
    expect(formatCommandTree(node)).toBe('bare\n');
  });

  it('indents children by two spaces per depth level and sorts siblings alphabetically', () => {
    const tree = {
      name: 'root',
      description: 'top',
      aliases: [],
      children: [
        { name: 'beta', description: 'b', aliases: [], children: [] },
        { name: 'alpha', description: 'a', aliases: ['al'], children: [
          { name: 'inner', description: 'i', aliases: [], children: [] },
        ] },
      ],
    };
    expect(formatCommandTree(tree)).toBe(
      'root — top\n' +
      '  alpha (al) — a\n' +
      '    inner — i\n' +
      '  beta — b\n',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ktx/cli exec vitest run src/command-tree.test.ts`

Expected: FAIL — `formatCommandTree` is not exported.

- [ ] **Step 3: Implement `formatCommandTree`**

Append to `packages/cli/src/command-tree.ts`:

```typescript
export function formatCommandTree(node: CommandTreeNode): string {
  const lines: string[] = [];
  appendNode(node, 0, lines);
  return `${lines.join('\n')}\n`;
}

function appendNode(node: CommandTreeNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  const aliasPart = node.aliases.length > 0 ? ` (${node.aliases.join(', ')})` : '';
  const descPart = node.description.length > 0 ? ` — ${node.description}` : '';
  lines.push(`${indent}${node.name}${aliasPart}${descPart}`);

  const sortedChildren = [...node.children].sort((a, b) => a.name.localeCompare(b.name));
  for (const child of sortedChildren) {
    appendNode(child, depth + 1, lines);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ktx/cli exec vitest run src/command-tree.test.ts`

Expected: PASS (7 of 7 across walkCommandTree + formatCommandTree).

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @ktx/cli run type-check`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/command-tree.ts packages/cli/src/command-tree.test.ts
git commit -m "feat(cli): add walkCommandTree and formatCommandTree helpers"
```

---

## Task 4: Script entrypoint `print-command-tree.ts`

Thin glue: build the program with stub IO/deps, walk, format, write to a provided stdout. Export a `main(stdout)` function for unit testing; only auto-run when invoked as a script.

**Files:**
- Create: `packages/cli/src/print-command-tree.ts`
- Create: `packages/cli/src/print-command-tree.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/print-command-tree.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { renderKtxCommandTree } from './print-command-tree.js';

describe('renderKtxCommandTree', () => {
  it('renders an indented tree rooted at "ktx" with known top-level commands', () => {
    const output = renderKtxCommandTree();

    const lines = output.split('\n');
    expect(lines[0]).toMatch(/^ktx( |$|\s—)/);

    // Top-level commands are indented exactly two spaces.
    const topLevel = lines
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim().split(' ')[0]);

    for (const expected of ['setup', 'serve', 'sl', 'dev']) {
      expect(topLevel).toContain(expected);
    }
  });

  it('ends with a single trailing newline', () => {
    const output = renderKtxCommandTree();
    expect(output.endsWith('\n')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ktx/cli exec vitest run src/print-command-tree.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the script**

Create `packages/cli/src/print-command-tree.ts`:

```typescript
import { fileURLToPath } from 'node:url';
import { buildKtxProgram } from './cli-program.js';
import type { KtxCliIo, KtxCliPackageInfo } from './cli-runtime.js';
import { formatCommandTree, walkCommandTree } from './command-tree.js';

function silentIo(): KtxCliIo {
  return {
    stdout: { isTTY: false, columns: 80, write: () => {} },
    stderr: { write: () => {} },
  };
}

function stubPackageInfo(): KtxCliPackageInfo {
  return { name: '@ktx/cli', version: '0.0.0-docs', contextPackageName: '@ktx/context' };
}

export function renderKtxCommandTree(): string {
  const program = buildKtxProgram({
    io: silentIo(),
    deps: {},
    packageInfo: stubPackageInfo(),
    runInit: async () => 0,
  });
  return formatCommandTree(walkCommandTree(program));
}

export function main(stdout: { write(chunk: string): void }): void {
  stdout.write(renderKtxCommandTree());
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  main(process.stdout);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ktx/cli exec vitest run src/print-command-tree.test.ts`

Expected: PASS — both assertions green.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @ktx/cli run type-check`

Expected: no errors.

- [ ] **Step 6: Build and run the script end-to-end**

Run:
```bash
pnpm --filter @ktx/cli run build
node packages/cli/dist/print-command-tree.js | head -20
```

Expected: first line begins with `ktx`, followed by indented top-level commands (`setup`, `serve`, `sl`, `dev`, etc.). No errors on stderr.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/print-command-tree.ts packages/cli/src/print-command-tree.test.ts
git commit -m "feat(cli): add print-command-tree build-time script"
```

---

## Task 5: Wire pnpm script and document

Expose the script through pnpm so contributors and CI don't need to remember the `node dist/…` path.

**Files:**
- Modify: `packages/cli/package.json` (add `docs:commands` to `scripts`)

- [ ] **Step 1: Inspect existing scripts block**

Run: `node -e "const p=require('./packages/cli/package.json'); console.log(JSON.stringify(p.scripts, null, 2))"`

Note the current keys (`build`, `smoke`, `test`, `test:slow`, `type-check`, `assets:demo`). Add a new entry that depends on `build`.

- [ ] **Step 2: Add the `docs:commands` script**

Edit `packages/cli/package.json`. In the `"scripts"` object, add (after `"build"`):

```json
"docs:commands": "pnpm run build && node dist/print-command-tree.js",
```

Keep alphabetical-ish ordering consistent with the existing block; if other scripts use `&&` chains for build prerequisites, match the style.

- [ ] **Step 3: Verify the script runs**

Run: `pnpm --filter @ktx/cli run docs:commands | head -30`

Expected: builds the CLI, then prints the tree (first line `ktx ...`, two-space-indented children below).

- [ ] **Step 4: Verify nothing else broke**

Run in parallel:
- `pnpm --filter @ktx/cli run type-check`
- `pnpm --filter @ktx/cli run test`

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json
git commit -m "chore(cli): add docs:commands pnpm script"
```

---

## Verification Summary

After all tasks, confirm:

- [ ] `pnpm --filter @ktx/cli run type-check` — clean
- [ ] `pnpm --filter @ktx/cli run test` — green, including new tests in `cli-program.test.ts`, `command-tree.test.ts`, `print-command-tree.test.ts`
- [ ] `pnpm --filter @ktx/cli run docs:commands` — prints `ktx` followed by indented subcommand tree
- [ ] `git status --short` — only the files listed in the File Map are modified or created; no incidental edits

If any check fails, fix in place and re-run before declaring done.
