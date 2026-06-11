# ktx-daemon

`ktx-daemon` is the portable Python compute package for **ktx**.

It supports portable compute in two modes:

- One-shot commands, used by default by the `@kaelio/ktx` CLI.
- An explicit HTTP server for long-running local MCP sessions.

## One-shot semantic query

```bash
printf '%s\n' '{"sources":[],"query":{"measures":[],"dimensions":[]},"dialect":"postgres"}' \
  | ktx-daemon semantic-query
```

## One-shot source generation

Generate semantic-layer sources from schema scan data:

```bash
printf '%s\n' '{"tables":[{"name":"orders","db":"public","columns":[{"name":"id","type":"integer","primary_key":true}]}],"links":[],"dialect":"postgres"}' \
  | ktx-daemon semantic-generate-sources
```

## One-shot database introspection

Introspect a Postgres database schema:

```bash
printf '%s\n' '{"connection_id":"warehouse","driver":"postgres","url":"postgresql://readonly@example.test/warehouse","schemas":["public"]}' \
  | ktx-daemon database-introspect
```

## One-shot LookML parsing

Parse LookML projects into resolved, KSL-ready structures:

```bash
printf '%s\n' '{"files":[{"path":"views/orders.view.lkml","content":"view: orders { sql_table_name: public.orders ;; measure: order_count { type: count } }"}],"dialect":"postgres"}' \
  | ktx-daemon lookml-parse
```

## One-shot embeddings

Compute text embeddings locally:

```bash
printf '%s\n' '{"text":"hello"}' \
  | ktx-daemon embedding-compute
```

Compute text embeddings locally in bulk:

```bash
printf '%s\n' '{"texts":["hello","world"]}' \
  | ktx-daemon embedding-compute-bulk
```

## One-shot code execution

Execute Python code with the current in-process boundary:

```bash
printf '%s\n' '{"code":"result = 1 + 2"}' \
  | ktx-daemon code-execute
```

## HTTP compute server

Start the HTTP compute server with code execution disabled:

```bash
ktx-daemon serve-http --host 127.0.0.1 --port 8765
```

Enable HTTP code execution explicitly:

```bash
ktx-daemon serve-http --host 127.0.0.1 --port 8765 --enable-code-execution
```

Available HTTP endpoints:

- `GET /health`
- `POST /database/introspect`
- `POST /embeddings/compute`
- `POST /embeddings/compute-bulk`
- `POST /lookml/parse`
- `POST /semantic-layer/generate-sources`
- `POST /semantic-layer/query`
- `POST /semantic-layer/validate`
- `POST /code/execute` when `--enable-code-execution` is passed

The HTTP server exposes Postgres database introspection, LookML parsing, local
embedding compute, and semantic-layer compute for source generation, query
compilation, and validation.
Code execution is off by default. When enabled, it runs Python `exec` in the
daemon process with the same in-process boundary as the one-shot
`code-execute` command and does not provide OS-level sandboxing.

HTTP code execution uses the standalone **ktx** boundary. It does not forward
caller authorization headers to a host app and does not connect scratchpad or
visualization helpers to host application APIs.
