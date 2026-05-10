# npm-managed Python runtime design

This spec defines how KTX ships as one visible npm package while still using
Python for sqlglot, semantic-layer planning, database-agent compute, and local
embeddings. The goal is a user experience where users install or run only
`@kaelio/ktx`, and KTX manages its Python runtime automatically when a command
needs it.

## Goals

KTX must be usable through the npm package `@kaelio/ktx` with a `ktx` binary.
Users can run KTX without learning about the Python packages that power parts of
the system.

The first release must support these invocation modes:

- `npx @kaelio/ktx setup demo`
- `npx @kaelio/ktx sl query ...`
- `npm install @kaelio/ktx`, followed by `npx ktx ...`
- `npm install -g @kaelio/ktx`, followed by `ktx ...`

KTX-owned Python code must ship inside the npm package as a bundled wheel. KTX
doesn't need to publish its own Python code to PyPI for this release.

## Non-goals

This release does not need to provide a public TypeScript SDK split across
multiple npm packages. The internal workspace package layout can remain useful
for development, but the public npm surface is a single package.

This release does not need a fully offline install. KTX's own Python wheel is
bundled, but third-party Python dependencies can come from PyPI through `uv`.

This release does not install local embedding dependencies by default. Local
embeddings remain lazy because `sentence-transformers`, `torch`, and model
downloads are large.

## Package model

KTX publishes one public npm package:

```text
@kaelio/ktx
```

That package exposes one binary:

```json
{
  "bin": {
    "ktx": "./dist/bin.js"
  }
}
```

The npm package includes these assets:

- Bundled JavaScript CLI output.
- Packaged demo assets.
- One KTX-owned Python wheel, for example
  `python/kaelio_ktx-0.1.0-py3-none-any.whl`.
- A wheel checksum or runtime manifest that lets the CLI verify the bundled
  Python payload before installation.

The Python wheel contains the current `semantic_layer` and `ktx_daemon`
modules. It exposes at least the `ktx-daemon` console script.

## Runtime installation

KTX creates a managed Python runtime only when a command needs Python-backed
behavior. The runtime lives outside the npm cache so it survives `npx` runs.

The runtime root is platform-specific:

- macOS: `~/Library/Application Support/kaelio/ktx/runtime`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/kaelio/ktx/runtime`
- Windows: `%LOCALAPPDATA%/Kaelio/KTX/runtime`

The runtime is versioned by the npm package version. A versioned runtime avoids
mixing JavaScript and Python code from incompatible releases.

The installer performs these steps:

1. Locate `uv`.
2. Create a virtual environment under the versioned runtime directory.
3. Install the bundled KTX wheel into that environment.
4. Write a runtime manifest with the CLI version, wheel checksum, Python
   executable, daemon executable, and installed feature set.

For lightweight Python support, the install command uses the bundled wheel's
default dependency set. For local embeddings, the installer adds the embeddings
extra only when selected:

```bash
uv pip install "/path/to/kaelio_ktx-0.1.0-py3-none-any.whl"
uv pip install "/path/to/kaelio_ktx-0.1.0-py3-none-any.whl[local-embeddings]"
```

## Feature installation levels

KTX manages Python runtime features in levels so first use stays fast.

`core` includes:

- `sqlglot`
- `pydantic`
- `pyyaml`
- `fastapi`
- `uvicorn`
- lightweight daemon dependencies

`local-embeddings` adds:

- `sentence-transformers`
- `torch`
- model download support for `all-MiniLM-L6-v2`

Commands that only need semantic-layer SQL generation require `core`.
Commands that need local embeddings require `local-embeddings`.

## Command behavior

Pure TypeScript commands run without the managed Python runtime.

Python-backed one-shot operations use the managed `ktx-daemon` executable
directly. Examples include semantic query compilation, semantic validation,
semantic source generation, and sqlglot-backed table identifier parsing.

Repeated or expensive operations use a managed HTTP daemon. Local embeddings use
the daemon because loading the model for every one-shot process is too slow.

KTX provides runtime management commands:

```bash
ktx runtime install
ktx runtime status
ktx runtime start
ktx runtime stop
ktx runtime doctor
ktx runtime prune
```

Normal commands can install the runtime lazily. Runtime commands make that
behavior inspectable and debuggable.

## Daemon lifecycle

The daemon binds to `127.0.0.1` on an available random port. KTX writes daemon
state to the runtime manifest or an adjacent state file:

```json
{
  "pid": 12345,
  "port": 58731,
  "version": "0.1.0",
  "features": ["core", "local-embeddings"],
  "startedAt": "2026-05-11T00:00:00Z"
}
```

Before reusing a daemon, KTX checks that the process is alive, the port responds
to `/health`, and the daemon version matches the CLI version. If any check
fails, KTX treats the daemon as stale and starts a new one.

KTX uses one-shot Python for short operations by default. It starts the daemon
only when a command benefits from process reuse.

## Interactive and CI behavior

In an interactive terminal, KTX prompts before installing the managed runtime
for the first time. The prompt states that Python dependencies will be
downloaded.

With `--yes`, KTX installs the required runtime features without prompting.

With `--no-input`, KTX fails if a required runtime feature is missing and no
explicit auto-install flag is present. The error prints the exact command to
prepare the runtime.

For local embeddings, KTX prompts separately because the dependency and model
downloads are larger than the core runtime.

## Error handling

If `uv` is missing, KTX prints a focused error that explains how to install it
and how to retry. A later release can add a bundled or downloaded `uv` strategy.

If Python runtime installation fails, KTX preserves install logs in the runtime
directory and prints the log path.

If the daemon fails to start, KTX prints the captured daemon stdout and stderr
path. It falls back to one-shot mode only when the requested operation supports
one-shot execution.

If JavaScript and Python versions don't match, KTX reinstalls the managed
runtime for the current npm package version.

## Release flow

The release builds the Python wheel before packing npm artifacts. The npm pack
step includes the wheel as an asset.

Release checks must cover:

1. Clean install of the packed npm package.
2. `npx` execution of the packed package.
3. First-run managed runtime install from the bundled wheel.
4. One-shot semantic-layer query through the managed runtime.
5. Runtime status and doctor output.
6. Daemon start, health check, reuse, and stop.
7. Optional local embeddings smoke in a separate job or opt-in check.

## Open decisions

KTX still needs a final decision on whether `uv` is a hard prerequisite or a
bootstrap dependency that KTX downloads automatically.

KTX also needs the final Python distribution name. This spec uses
`kaelio-ktx` as the distribution name and `kaelio_ktx` in wheel filenames.

## Success criteria

Users can run `npx @kaelio/ktx ...` and complete Python-backed KTX operations
without manually installing a KTX Python package.

Users who install `@kaelio/ktx` locally can run `npx ktx ...` through the local
project's npm binary resolution.

The first Python-backed command installs only the core runtime. Local embedding
dependencies install only after the user selects local embeddings or explicitly
requests the `local-embeddings` runtime feature.

KTX can diagnose and repair stale or mismatched managed runtimes without asking
users to delete directories manually.
