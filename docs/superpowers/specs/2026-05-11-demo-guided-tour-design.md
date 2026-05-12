# Demo Guided Tour — Design Spec

## Problem

The "Try KTX with packaged demo data" option in `ktx setup` is completely
disconnected from the real setup wizard. It bypasses all wizard steps, plays
an animated replay in a temp directory, and exits with no bridge to actually
using KTX. Users don't learn the real setup flow and hit a dead end.

## Solution

Redesign the demo option as a **guided tour** that walks the user through the
same setup wizard steps with pre-filled, read-only selections. The tour ends
with a real interactive agents step so the user can immediately use the demo
project with their coding agent.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Implementation strategy | Demo mode flag on existing wizard steps | Maximum code reuse; wizard changes automatically apply to demo |
| LLM/embeddings steps | Skipped | Not relevant to pre-packaged demo data |
| Database selection | PostgreSQL (read-only card) | Pre-filled, matches demo dataset |
| Context sources | dbt, Metabase, Notion (read-only card) | Pre-filled, matches demo dataset |
| Context build | Replay through real progress visualization | Same spinners, progress bars, status icons as real build |
| Agents step | Real interactive step | User actually connects their agent |
| Project location | Temp directory (`/tmp/ktx-demo-{hex}`) | Frictionless, no directory prompt |
| Navigation | Enter to advance, Escape to go back | Consistent with rest of wizard |

## Flow

```
Entry menu: "Try KTX with packaged demo data"
    │
    ▼
Create demo project in /tmp/ktx-demo-{hex}
Copy pre-packaged assets (demo DB, replay, context artifacts)
    │
    ▼
┌────────────────────────────────────────────────────────────────┐
│ Demo banner (persistent, shown on every step)                  │
│                                                                │
│ Demo mode — data has been pre-processed and KTX context is     │
│ already built. This walkthrough illustrates the setup steps.   │
│ Selections are pre-filled and read-only.                       │
└────────────────────────────────────────────────────────────────┘
    │
    ▼
Read-only card: Database connection
  ▸ PostgreSQL (demo warehouse)
  [Enter → next, Escape → back to entry menu]
    │
    ▼
Read-only card: Context sources
  ▸ dbt
  ▸ Metabase
  ▸ Notion
  [Enter → next, Escape → back to database card]
    │
    ▼
Context build replay
  Same renderContextBuildView() / repainter as real wizard
  Sources: demo-warehouse, dbt, metabase, notion
  Replay at slightly faster-than-real pace
  Completion summary: business areas, query definitions, knowledge pages
  [Enter → next, Escape → back to sources card]
    │
    ▼
Transition message:
  "Demo project is ready — let's connect your agent"
    │
    ▼
Interactive agents step (real runKtxSetupAgentsStep())
  User selects agent target, scope, install mode
  [Normal interactive navigation; Escape goes back to replay summary]
    │
    ▼
Final summary:
  ★ KTX demo is ready
  Agent connected, project path shown
  ⚠ Temp directory warning
  Pointer to `ktx setup` for real data
```

## Step Details

### Demo Banner

Shown at the top of every read-only step. Uses clack box-drawing style:

```
┌ Demo mode — data has been pre-processed and KTX context is already built.
│ This walkthrough illustrates the setup steps. Selections are pre-filled and read-only.
```

### Read-Only Step Cards

Rendered by a shared `renderDemoCard()` helper:

```typescript
async function renderDemoCard(
  title: string,
  selections: string[],
  io: KtxCliIo,
): Promise<'forward' | 'back'>
```

- Renders a clack-style box with title, bullet list of pre-filled selections,
  and navigation hint ("Press Enter to continue, Escape to go back")
- Listens for raw keypresses: Enter → `'forward'`, Escape → `'back'`
- Uses same box-drawing characters and colors as `@clack/prompts`

Card format:

```
┌  {title}
│
│  ▸ {selection 1}
│  ▸ {selection 2}
│  ...
│
│  Press Enter to continue, Escape to go back
└
```

### Demo Step Sequence

The demo reuses the main wizard's step loop with these steps:

```typescript
const demoSteps = ['databases', 'sources', 'context', 'agents'];
```

Steps `databases` and `sources` dispatch to `renderDemoCard()` instead of
their real interactive functions when demo mode is active. Step `context`
dispatches to the replay visualization. Step `agents` runs the real
`runKtxSetupAgentsStep()`.

Back navigation reuses `previousNavigableStepIndex()`. Escaping from the
first step (databases) returns to the entry menu.

### Context Build Replay

Uses the same rendering pipeline as the real context build:

- `renderContextBuildView()` for the progress display
- `createRepainter()` for terminal repainting
- Same spinner frames, progress bars (`████░░░░`), status icons (`✓`, `⠹`, `○`)
- Same source grouping (Primary sources / Context sources)

Sources shown:

```
Primary sources:
  ✓ demo-warehouse          completed · Xs

Context sources:
  ✓ dbt                     completed · Xs
  ✓ metabase                completed · Xs
  ✓ notion                  completed · Xs
```

Replay timing: events from the pre-packaged replay file are played back at
a slightly faster pace than real-time (compressed to feel brisk but not
instant).

Completion summary uses the existing format:

```
★ KTX finished ingesting your data

  ✓ Analyzed X business areas
  ✓ Reconciled — 0 conflicts

  KTX created:
    📊 X query definitions
    📝 X knowledge pages

  Press Enter to continue, Escape to go back
```

The exact counts and artifact names come from the pre-packaged demo results
(to be provided by the user as improved demo data).

### Agents Step Transition

A brief message bridges from the read-only tour to the interactive step:

```
┌  Demo project is ready — let's connect your agent
│
│  Your KTX context has been built with demo data.
│  Select an agent to start using it.
└
```

Then `runKtxSetupAgentsStep()` runs with the demo project directory,
normal interactive prompts enabled.

### Final Summary

```
★ KTX demo is ready

  Your agent is connected to a demo KTX project.

  ⚠ This project is in a temporary directory and will be
    cleaned up by your system. To set up KTX with your own
    data, run: ktx setup

  Project: /tmp/ktx-demo-a1b2c3
```

If the user skips the agents step, replace the first line with manual
agent connection instructions (`ktx setup --agents --project-dir /tmp/...`).

## Implementation Approach

Thread a `demoMode` flag through the main setup loop in `setup.ts`. When
active:

1. Skip `models` and `embeddings` steps entirely
2. Replace `databases` and `sources` step dispatch with `renderDemoCard()`
3. Replace `context` step dispatch with replay visualization
4. Run `agents` step normally
5. Show demo-specific completion summary instead of ready menu

The `renderDemoCard()` helper is a new function in a new file
(e.g. `setup-demo-cards.ts`) that handles read-only card rendering and
keypress listening.

The context build replay reuses existing `renderContextBuildView()` and
`createRepainter()` from `context-build-view.ts`, fed with events from
the pre-packaged replay file at an accelerated playback rate.

## Files Changed

| File | Change |
|------|--------|
| `packages/cli/src/setup.ts` | Add `demoMode` flag to setup loop; skip models/embeddings; dispatch to demo cards for databases/sources; show demo banner; demo completion summary |
| `packages/cli/src/setup-demo-cards.ts` | New file: `renderDemoCard()` helper, demo banner renderer, demo step definitions |
| `packages/cli/src/setup-context.ts` | Support replay mode for demo: feed pre-packaged events at accelerated pace through existing progress view |
| `packages/cli/src/demo.ts` | Remove or simplify `runKtxSetupDemoFromEntryMenu()` — now dispatches to the main setup loop with `demoMode: true` |
| `packages/cli/src/demo-assets.ts` | Update asset list if new demo data is provided; ensure demo project setup writes valid `ktx.yaml` for agent use |

## Open Items

- **Demo data**: User will provide improved pre-packaged results (Postgres,
  dbt, Metabase, Notion). Current demo assets may need updating.
- **Replay speed**: Exact acceleration factor TBD — should feel brisk but
  give users time to read source names and status transitions. Start with
  ~2x real-time and adjust.
