# Package artifact smoke checks

The package artifact smoke checks create temporary projects instead of storing
sample projects in this directory. Run the checks from `ktx/`:

```bash
pnpm run artifacts:check
```

The npm smoke project installs the generated public `@kaelio/ktx` tarball,
imports the package entry point, and runs installed `ktx` commands against a
generated local project.

The managed Python runtime smoke requires `uv` on `PATH`, isolates
`KTX_RUNTIME_ROOT`, verifies `ktx runtime status`, runs `ktx sl query --yes` to
install the core runtime from the bundled wheel, checks `ktx runtime doctor`,
starts and reuses the managed daemon, stops it, previews a stale runtime with
`ktx runtime prune --dry-run`, verifies confirmation is required, and removes
the stale runtime with `ktx runtime prune --yes`.

The Python smoke project still installs the Python artifacts directly because
it verifies the standalone Python distributions that feed the bundled runtime
wheel.
