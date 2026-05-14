# KTX Development Notes

KTX is a standalone open-source context layer for database agents. These
instructions apply to all agents working in this repository (Codex, Claude,
Gemini, and similar tools). Do not assume an external app server, frontend,
database migrations, ORPC contracts, or `python-service/` layout exist here.

## Critical Rules

### Absolute Requirements

- **MUST**: Use the active agent's task tracker for tasks with 3+ steps or
  complex operations (`TodoWrite` in Claude, `update_plan` in Codex).
- **MUST**: Read files before editing them.
- **MUST**: Complete all tracked tasks before finishing.
- **MUST**: Activate `.venv` before running Python code when a local virtualenv
  exists. If no `.venv` exists, use `uv run ...` from the relevant project root.
- **MUST**: After modifying Python files, run the relevant Python tests and run
  `uv run pre-commit run --files [FILES]` when a pre-commit config exists. If
  pre-commit cannot run because config or tool versions are missing, state that
  explicitly and run the closest available checks.
- **MUST**: Remove dead code; do not leave commented-out code, unused wrappers,
  or empty directories.
- **MUST**: Keep package/public API changes intentional. Do not add compatibility
  wrappers for old KTX names unless the user explicitly asks for a migration
  bridge.
- **MUST**: Treat KTX as having no public users unless the user says otherwise.
  Legacy support is not necessary by default; prefer clean breaking changes over
  compatibility shims, migration bridges, or preserved stale behavior.

### Absolute Prohibitions

- **MUST NOT**: Use raw `pip`; use `uv`.
- **MUST NOT**: Use `npm` or `bun`; use `pnpm`.
- **MUST NOT**: Run destructive git cleanup commands (`git clean`,
  `git reset --hard`, `git checkout .`) unless the user explicitly requested
  that exact operation.
- **MUST NOT**: Run `git stash`, `git stash pop`, `git stash apply`, or
  `git stash drop` without explicit user instruction. Prefer a branch plus
  commit when the user asks to save work in progress.
- **MUST NOT**: Reintroduce external app conventions such as ORPC contracts,
  NestJS controllers, frontend routes, `routeTree.gen.ts`, or app database
  migration commands unless those systems are intentionally added to KTX later.

### Language Convention

- **MUST**: Absolute requirement, never deviate.
- **MUST NOT**: Absolute prohibition.
- **SHOULD**: Strong recommendation, deviate only with good reason.
- **MAY**: Optional, at agent's discretion.

## Priority Hierarchy

When rules conflict, follow this order:

1. Safety and user intent
2. Correctness: code works and verification passes
3. Single source of truth and DRY design
4. Code quality: types, readable boundaries, focused modules
5. Performance where it matters

## Repository Shape

KTX is a pnpm + uv workspace.

- TypeScript packages: `packages/*`
- CLI package: `packages/cli`
- Core context package: `packages/context`
- LLM package: `packages/llm`
- Database connectors: `packages/connector-*`
- Python semantic layer: `python/ktx-sl`
- Python daemon: `python/ktx-daemon`
- Examples and fixtures: `examples/`
- Workspace scripts: `scripts/`
- Local agent skills are private overlays. Do not commit `.agents/` or
  `.claude/` to this public repository.

Some package names still contain `ktx` during the split. Do not mass-rename
symbols, package names, paths, or docs to `ktx` unless the task asks for that
rename.

## Quick Commands

### TypeScript Workspace

```bash
pnpm install
pnpm run build
pnpm run type-check
pnpm run test
pnpm run check
pnpm run dead-code
pnpm --filter @ktx/cli run smoke
pnpm --filter './packages/*' run build
pnpm --filter './packages/*' run test
pnpm --filter './packages/*' run type-check
```

### Python Workspace

```bash
uv sync --all-groups
uv run pytest -q
uv run pytest python/ktx-sl/tests -q
uv run pytest python/ktx-daemon/tests -q
uv run pre-commit run --files [FILES]
```

If `pyproject.toml` pins a newer `uv` than the local binary, do not edit the
pin just to make checks pass. Report the version mismatch and run checks that
do not require changing project configuration.

### CLI and Release Checks

```bash
pnpm run setup:dev
pnpm run link:dev
pnpm run artifacts:verify
pnpm run release:readiness
pnpm run release:published-smoke
```

## Verification After Changes

Choose the smallest checks that cover the changed surface, then broaden when
shared contracts or package exports are affected.

- TypeScript package code: `pnpm --filter <package> run type-check` and
  `pnpm --filter <package> run test`
- Cross-package TypeScript changes: `pnpm run type-check` and `pnpm run test`
- Build/export changes: `pnpm run build`
- Workspace scripts: `node --test scripts/*.test.mjs` or the specific script
  test file
- TypeScript dead-code tooling/config changes: `pnpm run dead-code`
- Python semantic layer: `uv run pytest python/ktx-sl/tests -q`
- Python daemon: `uv run pytest python/ktx-daemon/tests -q`
- Python files: also run `uv run pre-commit run --files [FILES]` when
  pre-commit is configured

For test suites that take a while, capture full output once and inspect that
file instead of rerunning to apply different filters:

```bash
pnpm run test 2>&1 | tee /tmp/ktx-test-output.log
```

## TypeScript Standards

- Use Node 22+ and pnpm workspace commands.
- Keep packages ESM (`"type": "module"`) and preserve `NodeNext` TypeScript
  semantics.
- Prefer strict types over `any`; do not use `as unknown as`.
- Keep package exports, `types`, and built `dist` expectations aligned when
  changing public APIs.
- Use `zod` schemas for runtime validation at CLI/config/API boundaries.
- Keep connector packages thin: connector-specific scanning/auth behavior
  belongs in `packages/connector-*`; shared types and orchestration belong in
  `packages/context`.
- Avoid circular package dependencies. Shared code should move to the lowest
  sensible package, not be duplicated across connectors.
- Do not manually edit generated or built output under `dist/`; edit source and
  rebuild.

### Dead TypeScript Code Checks

KTX uses Biome for local unused-code linting and Knip for workspace graph
analysis. These checks are intentionally part of CI and pre-commit because the
normal development workflow is agent-based.

- Run `pnpm run dead-code` after TypeScript changes.
- Treat Knip findings as investigation prompts, not automatic deletion orders.
- Remove private dead code when you confirm there are no imports, dynamic
  references, generated references, or tests that still need it.
- Preserve public package exports unless the task explicitly includes API
  pruning.
- Add narrow `knip.json` ignores only for intentional dynamic or public cases.
  Do not add broad package-level ignores to silence unrelated findings.
- Update `knip.json` when adding dynamic entrypoints, generated files, package
  exports, CLI bins, or framework files that Knip cannot infer.

### CLI Standards

- Use Commander for CLI command trees, arguments, options, help text, custom
  parsers, and async action dispatch. Prefer `@commander-js/extra-typings` for
  typed command definitions, use `InvalidArgumentError` for parse failures, and
  call `parseAsync` when actions await asynchronous work.
- Use `@clack/prompts` for interactive flows. Always handle cancellation with
  `isCancel` plus `cancel`, stop active spinners before exiting, and keep prompts
  grouped or factored so multi-step setup flows share cancellation behavior.
- When CLI behavior is shared by the `ktx setup` wizard and other `ktx`
  commands, reuse or extract components in `packages/cli/src` instead of
  duplicating setup-only logic. Prefer neutral helpers such as `clack.ts`,
  `prompt-navigation.ts`, and command-independent prompt adapters over imports
  from setup command internals.
- Keep command behavior scriptable: prefer flags and config over prompts when
  values are supplied, and reserve prompts for interactive missing input or
  explicit setup flows.

### Zod Naming Convention

```typescript
const userSchema = z.object({
  id: z.uuid(),
  email: z.string().email(),
  name: z.string(),
});

type User = z.infer<typeof userSchema>;
```

Runtime schemas use `camelCase` plus the `Schema` suffix. Static inferred types
use `PascalCase` without the suffix.

## Python Standards

- Use `pyproject.toml`; do not add `requirements.txt`.
- Use type hints for new and changed Python code.
- Use `pathlib` instead of `os.path`.
- Use `logger.exception()` when catching and logging exceptions.
- Prefer explicit exception types over broad `except Exception`.
- Keep `python/ktx-sl` focused on semantic-layer planning and SQL generation.
- Keep `python/ktx-daemon` focused on portable daemon/API behavior around the
  semantic layer.

### SQL and Structured Parsing

- Prefer AST-based parsing over regex for structured input.
- For SQL, use `sqlglot`; it is already a dependency.
- In `python/ktx-sl`, follow the local `python/ktx-sl/AGENTS.md` guidance:
  parse expressions with sqlglot, quote reserved identifiers before parsing,
  and generate postgres-shaped SQL before final dialect transpilation.
- Regex may be used for non-structural sanitization, but not to interpret SQL
  structure.

## Documentation and Specs

- Keep public documentation in `README.md`, package READMEs, example READMEs,
  and the `docs-site/` Fumadocs tree.
- Prefer concrete commands, file paths, and acceptance criteria over broad
  prose.
- When documenting examples, ensure referenced files and commands exist in the
  standalone KTX tree.
- Remove or rewrite stale external app references unless the doc is explicitly
  historical.

### Updating `docs-site/` After Code Changes

Before finishing a task, decide whether `docs-site/content/docs/` needs an
update. Update it when your change affects user-visible behavior, including:

- New, renamed, or removed CLI commands, flags, or subcommands
  (`docs-site/content/docs/cli-reference/`)
- Changes to `ktx.yaml`, environment variables, or other configuration users
  edit
- New or changed connectors, integrations, or supported drivers
  (`docs-site/content/docs/integrations/`)
- Changes to setup, install, or getting-started flows
  (`docs-site/content/docs/getting-started/`)
- New concepts, agent capabilities, or workflows users should know about
  (`docs-site/content/docs/concepts/`, `docs-site/content/docs/guides/`)

Skip docs updates for purely internal refactors, test-only changes, or fixes
that do not change user-facing behavior. When you do update docs, follow the
`fumadocs-mdx-structure` skill and keep examples copy-pasteable. If a change
warrants docs but you are out of scope, call it out in your final summary
rather than silently skipping it.

## LLM and Prompt Development

When creating or modifying agent prompts, system prompts, tool descriptions, or
skills:

- Use XML tags for major structure when it helps model reliability:
  `<role>`, `<workflow>`, `<examples>`, `<success_criteria>`.
- Use positive framing: tell the model what to do.
- Keep prompts compact and avoid duplicating the same rule in multiple places.
- Include 1-3 concrete examples when examples materially reduce ambiguity.
- Use AI SDK v6 patterns for TypeScript LLM work.
- Use the local `ai-sdk` skill when working with AI SDK code.

## Context7 and External Docs

- Use Context7 when official, current library documentation would materially
  reduce risk.
- Context7 "Monthly quota exceeded" errors are often transient. Retry before
  assuming the quota is exhausted.
- If Context7 remains unavailable, state the blocked lookup and use the best
  available local/source documentation.

## When to Ask vs Act

Act without asking when:

- Following explicit user instructions
- Running verification
- Fixing clear bugs or tool failures within the requested scope

Ask first when:

- Requirements are ambiguous
- The next step is destructive or would discard user work
- A breaking public API decision is not already implied by the task
- Missing credentials, live services, or external accounts are required

## Git and Worktree Safety

- The worktree may contain unrelated user changes. Do not revert files you did
  not change unless explicitly asked.
- Before committing, inspect `git status --short` and commit only intended
  files.
- Do not commit ignored dependency/build artifacts such as `node_modules/`,
  `.venv/`, `dist/`, coverage output, or local databases unless the task
  explicitly concerns packaged artifacts.
