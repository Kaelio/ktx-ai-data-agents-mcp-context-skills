# ktx Code-Design Principles

Principles agents must apply when writing or changing behavior in this
repository. These rules carry the same weight as the `MUST` / `MUST NOT`
rules in `AGENTS.md`.

Overengineering rarely looks like over-engineering at the line level. It
shows up as small, locally-reasonable choices that combine into a system
where features fail silently and bug fixes have to be applied N times. The
principles below are the lessons; if a piece of code violates one, that is
enough reason to fix it even when the local code "works."

## One way to say one thing

- **MUST NOT**: Accept two spellings of the same intent — e.g. a magic
  sentinel value AND absence-of-field both meaning "use the default". Pick
  one and reject the other.
- **MUST NOT**: Maintain two entry points that load/construct/resolve the
  same thing where one does strictly more work than the other. Callers
  will pick the wrong one. Unify them, or encode the difference as a
  required argument on a single entry point.
- **MUST NOT**: Let each consumer write its own private wrapper around a
  shared helper to make it usable. If three callers each prepend the same
  three lines, those three lines belong in the helper.

## Behavior follows from inputs, not from which path the caller took

- **MUST**: A function's result must depend on its arguments, not on
  which sibling function the caller happened to invoke first. If "did
  setup step S run?" determines correctness, S belongs INSIDE the function
  that needs it, or its absence must be a hard error — not a silent
  degradation.
- **SHOULD**: When a value on disk requires runtime resolution (start a
  process, read state, hit a service), the resolution belongs in ONE
  place that every consumer goes through. If some consumers get the
  resolved form and some get the raw form, the abstraction is broken.

## Failures must reach a decision-maker

- **MUST NOT**: Catch an error, log it through a logger that may be a
  no-op, and continue with a null/empty result. The error reaches no one.
  Either surface the failure to the caller (return type, status field,
  stderr line), or throw.
- **MUST**: A caller that receives "no result" must be able to
  distinguish "the input legitimately produced nothing" from "a
  dependency was unavailable" from "the operation was skipped." If those
  three look the same to the user, the system is hiding bugs — including
  this one.
- **MUST**: When a function returns `T | null` (or a "skipped" status),
  at least one caller in the codebase must branch on the negative case
  and surface it. If every caller treats absence as success, the function
  is laundering errors.

## Don't build seams without a second piece on the other side

- **MUST NOT**: Introduce an interface, abstract type, or "port" boundary
  with exactly one implementation and no concrete plan for a second.
  Abstractions are paid for with indirection; pay only when you collect.
- **MUST NOT**: Add an optional dep-injection slot (`deps.X ?? defaultX`)
  unless at least one test exercises the production default. If every
  test injects a fake, the production codepath is type-checked and
  untested.
- **MUST NOT**: Add a wrapper "in case" callers later need to extend it.
  Add the wrapper when the second caller arrives.

## Specification and behavior are one artifact

- **MUST**: When a schema, doc comment, or config description states a
  default or a meaning, the code MUST enforce it. Drift between
  "what the field claims" and "what the code does" is a contract bug
  even if both compile.
- **MUST**: When you change behavior, update the schema description, the
  doc, AND the example in the same change. Not later.

## Verify the path you claim to have fixed

- **MUST**: Before claiming a feature works, run a command that actually
  exercises it end-to-end and observe the side effect — the file
  written, the process contacted, the row stored. Type-check passing is
  necessary, not sufficient. A test passing against a fake is not
  evidence the real path works.
- **MUST**: Before declaring a bug fixed, grep for the same shape
  elsewhere. Bugs of the kind described in this section repeat. Fix the
  class, not just the instance.

## Naming asymmetries are bugs in waiting

- **SHOULD**: When two related identifiers have non-parallel names
  (`loadX` vs `loadHigherX`, `createY` vs `createDefaultY`, `xClient`
  vs `xService`), assume callers will pick the wrong one. Unify, or
  document inline why both must exist.

## Dispatch and contract leaks across per-variant layers

Layers with multiple per-variant implementations (warehouse drivers,
dialects, LLM providers, ingest adapters, historic-SQL probes) drift
toward parallel switches and informal contracts. The patterns below
look locally reasonable per file but multiply with the number of
variants times the number of consumers — every fix has to be applied
N times, and silent drift between variants is invisible until a user
hits it.

- **MUST NOT**: Maintain two or more files that switch on the same
  enum or string union to dispatch to per-variant behavior. Promote
  the dispatch to a single registry table keyed by the union, exposed
  through one resolution function. If you find yourself writing the
  third such switch, the second one was already a bug.
- **MUST**: When every variant of an abstraction implements the same
  method, the method belongs on the shared interface. An informal
  contract that every implementation happens to satisfy is a leak
  waiting to happen — callers will reach for the concrete class
  instead of the contract, and the next variant added will silently
  forget to implement it.
- **MUST**: When a layer has both a thin shared interface and rich
  per-variant concrete classes, they must agree. Either widen the
  interface so callers never need the concrete class, or make the
  concrete class private (test-only `/** @internal */` JSDoc plus a
  boundary check in `scripts/check-boundaries.mjs`). A class that is
  public AND has methods the interface does not expose is the exact
  configuration that produces leaks.

The warehouse driver / dialect layer in
`packages/cli/src/connectors/<driver>/` plus
`packages/cli/src/context/connections/{dialects,drivers}.ts` is the
canonical worked example: per-driver dialect classes carry
`/** @internal */`, `scripts/check-boundaries.mjs` enforces the import
boundary, and dispatch lives in the two registry files. Apply the
same shape to any other per-variant layer that grows beyond two
implementations.
