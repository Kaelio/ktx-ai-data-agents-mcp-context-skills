# `ktx setup --agents` output polish

## Problem

The current `ktx setup --agents` flow renders four visual issues:

1. The multiselect prompt embeds a long navigation hint
   (`Use Up/Down to move, Space to select or unselect, Enter to confirm,
   Escape to go back, or Ctrl+C to exit.`) directly into the question text.
   Clack uses the same message verbatim for the confirmed-state echo, so the
   hint stays on screen after the user has already answered.
2. After install, two heavy `note()` boxes appear back-to-back ("Agent
   integration complete" and "Required before using agents") with the same
   visual weight, making the post-install output feel boxed in.
3. The install-complete box has 3–4 levels of nested indentation, which is
   hard to scan.
4. The flow ends after the second box; there is no `outro` marker.

## Scope

Narrow: changes apply only to `runKtxSetupAgentsStep` in
`packages/cli/src/setup-agents.ts`. The shared `withMultiselectNavigation`
helper is left as-is so `setup --sources` and `setup --databases` keep their
current prompt rendering until a follow-up.

## Goals

- Replace the in-question navigation hint for the agents multiselect with a
  one-time `log.info(...)` line emitted before the first interactive prompt.
- Render the per-install summary inline using `log.step` (one block per
  install) instead of a `note()` box.
- Keep the "Required before using agents" `note()` box (the file paths users
  copy/paste benefit from visual framing).
- End the flow with `outro('All set.')` when next-actions are shown.

Non-goals:

- No change to the actual install logic, manifest, or generated config files.
- No change to `setup --sources` or `setup --databases` (deferred).
- No change to `formatAgentNextActions` content (only the surrounding `note`
  call site is touched; body stays).
- No path shortening to project-relative in next-actions output — users may
  copy/paste from terminals outside the project, so absolute paths stay.

## Design

### Prompt polish

In `runKtxSetupAgentsStep`, emit the navigation hint **once, only when
interactive prompts will actually run** (`args.inputMode === 'auto'` and
`args.target === undefined`), immediately before the first prompt:

```ts
log.info('Space to select, Enter to confirm, Esc to go back.');
```

In scripted mode (`inputMode === 'disabled'` or `--target` supplied), the
hint is skipped — no prompts run, so the help would be noise.

Replace `withMultiselectNavigation('Which agent targets should KTX install?')`
with the plain string `'Which agent targets should KTX install?'`.

The shared `withMultiselectNavigation` helper, its export, and its
`prompt-navigation.test.ts` test remain untouched — they still apply to the
other two setup flows.

### Install summary

Today: `formatInstallSummary(...)` returns a multi-line string that
`runKtxSetupAgentsStep` passes to `setupUi.note(..., 'Agent integration
complete', io)`.

New: rename `formatInstallSummary` to `formatInstallSummaryLines` and have it
return a structured array — one entry per install — with:

```ts
type InstallSummaryEntry = {
  title: string;          // e.g. "Claude Desktop · Global scope"
  lines: string[];        // body lines, no indentation prefix
};
```

`runKtxSetupAgentsStep` then iterates and emits one `log.step(title +
'\n' + body)` per install. The "KTX project / <path>" header line is dropped
(the user already sees the project path in the existing `intro` block, e.g.
`Project: /tmp/ktx7`).

Body lines for a Claude Desktop install:

```
~/Library/Application Support/Claude/claude_desktop_config.json
Skill bundles:
  /tmp/ktx7/.ktx/agents/claude/ktx-analytics.zip
  /tmp/ktx7/.ktx/agents/claude/ktx.zip
Starts KTX over stdio from Claude Desktop.
```

Body lines for a Claude Code project install (HTTP MCP target):

```
Project scope: /tmp/ktx7/.mcp.json
Requires MCP to be started.
Analytics skill installed.
Admin CLI skill installed.
```

Path rendering: replace a leading `$HOME` with `~` for absolute paths shown
inline in the body, leaving non-home paths untouched. Skill-bundle paths
inside `projectDir` stay absolute (users copy these into the Claude Desktop
file picker).

### Next actions

`formatAgentNextActions(...)` is unchanged. The `setupUi.note(...,
'Required before using agents', io, { format: (line) => line })` call site
stays. This is the one remaining box and acts as the visual payoff with
copy-pasteable instructions.

### Outro

After the next-actions note (when `args.showNextActions !== false`), emit:

```ts
outro('All set.');
```

When next actions are suppressed (`showNextActions === false`), no `outro` is
emitted — the caller is composing a larger flow.

## Final layout (Claude Desktop, global)

```
┌  KTX setup
│  Project: /tmp/ktx7
│
●  Space to select, Enter to confirm, Esc to go back.
│
◇  What should agents be allowed to do with this KTX project?
│  Ask data questions + manage KTX with CLI commands
│
◇  Which agent targets should KTX install?
│  Claude Desktop
│
◆  Claude Desktop · Global scope
│  ~/Library/Application Support/Claude/claude_desktop_config.json
│  Skill bundles:
│    /tmp/ktx7/.ktx/agents/claude/ktx-analytics.zip
│    /tmp/ktx7/.ktx/agents/claude/ktx.zip
│  Starts KTX over stdio from Claude Desktop.
│
◇  Required before using agents ───────────────────────────────────╮
│                                                                  │
│  1. Restart Claude Desktop                                       │
│    Claude Desktop loads KTX MCP after restart.                   │
│                                                                  │
│  2. Upload Claude Desktop skills                                 │
│    Open Claude Desktop: Customize > Skills > + > Create skill.   │
│    Upload these files:                                           │
│    /tmp/ktx7/.ktx/agents/claude/ktx-analytics.zip                │
│    /tmp/ktx7/.ktx/agents/claude/ktx.zip                          │
│    Toggle the uploaded KTX skills on.                            │
│                                                                  │
├──────────────────────────────────────────────────────────────────╯
│
└  All set.
```

## Test impact

`packages/cli/src/setup-agents.test.ts` — four tests update:

- **`explains how to select multiple agent targets in interactive mode`**
  (L879) — currently asserts the multiselect `message` ends with the long
  navigation hint string. Update to assert the plain message string. The test
  name and intent shift: it now verifies the multiselect message no longer
  embeds the hint and that the navigation hint was emitted once via stdout
  before the prompts (`Space to select, Enter to confirm, Esc to go back.`).
- **`prints per-agent install summary after successful installation`**
  (L911) — currently asserts `Agent integration complete` appears in stdout
  plus the multi-level indented summary structure (`KTX project\n
  ${tempDir}`, `Installed agents`, `Project scope\n      ${path}`).
  Update to assert the new inline `log.step` lines:
  - `Claude Code · Project scope` heading
  - path on its own line (e.g., `${join(tempDir, '.mcp.json')}`)
  - `Requires MCP to be started.`
  - `Analytics skill installed.`
  - `Admin CLI skill installed.`
  - Stops asserting `Agent integration complete` and `KTX project\n  …`.
- **`formats summary with explicit project-scoped config paths`** (L942) and
  **`formats summary with multiple agent targets`** (L961) — call
  `formatInstallSummary` directly. Update to call
  `formatInstallSummaryLines` and assert on the returned structured array
  shape and content per install.
- **`can return agent next actions without printing them`** (L212) — asserts
  `'Agent integration complete'` appears in stdout when `showNextActions:
  false`. Update to assert the new heading `Claude Code · Project scope`
  appears instead.

The next-actions assertions (L181, L1028, L1089) keep passing — that code
path is unchanged.

## Verification

- `pnpm --filter @ktx/cli run type-check`
- `pnpm --filter @ktx/cli run test`
- Manual run: `ktx setup --agents` against `/tmp/ktx7` (or any fresh project)
  with `--target claude-desktop --scope global --mode mcp-cli` to compare
  against the layout above.

## Risks

- The `formatInstallSummary` rename is a breaking change for any external
  importer. Grep confirms it is only imported from
  `packages/cli/src/setup-agents.test.ts`; no production consumer outside
  `runKtxSetupAgentsStep`. KTX has no public users (`feedback_ktx_no_backward_compat`),
  so a clean rename is acceptable.
- `log.info` for the navigation hint runs in TTY mode only via Clack. In
  non-TTY mode (`setupUi.note` falls back to plain stdout) the hint is not
  emitted. Acceptable because non-TTY runs are scripted (`--target`/`--yes`)
  and don't need keyboard help.
