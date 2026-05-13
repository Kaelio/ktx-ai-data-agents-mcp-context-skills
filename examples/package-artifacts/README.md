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
`KTX_RUNTIME_ROOT`, verifies `ktx dev runtime status`, runs `ktx sl query --yes` to
install the core runtime from the bundled wheel, checks `ktx dev runtime status`,
starts and reuses the managed daemon, stops it, previews a stale runtime with
`ktx dev runtime prune --dry-run`, verifies confirmation is required, and removes
the stale runtime with `ktx dev runtime prune --yes`.

The artifact manifest contains the public `@kaelio/ktx` npm tarball and the
bundled `kaelio-ktx` runtime wheel. The smoke does not install standalone
Python packages directly; Python-backed behavior is verified through the
managed runtime installed from the npm package.
