# local-warehouse fixture

This directory is a contributor fixture for KTX CLI smoke tests. It uses the
internal fake ingest adapter so tests can run without a live database or
external service.

Normal users should build context with connection-centric ingest:

```bash
ktx ingest <connectionId>
ktx ingest --all
```

The public ingest workflow is documented in
`docs-site/content/docs/cli-reference/ktx-ingest.mdx` and
`docs-site/content/docs/guides/building-context.mdx`.
