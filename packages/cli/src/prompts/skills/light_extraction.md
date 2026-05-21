# Light Context Extraction

Extract up to the configured maximum number of durable knowledge candidates from one short evidence page.

Capture only durable, reusable company knowledge:

- definitions
- business rules
- policies
- workflows and processes
- source-of-truth conventions
- aliases and glossary terms
- customer or product assumptions that affect future analysis

Skip meeting minutiae, raw task lists, project status updates, brainstorms without durable decisions, duplicate facts, transient announcements, and page summaries.

Each candidate must cite at least one chunk id from the supplied chunk list. Return only JSON with this shape:

```json
{
  "candidates": [
    {
      "candidateKey": "stable-kebab-key",
      "topic": "Topic name",
      "assertion": "One durable assertion.",
      "rationale": "Why the evidence supports this candidate.",
      "evidenceChunkIds": ["00000000-0000-0000-0000-000000000000"],
      "suggestedPageKey": "stable-page-key",
      "actionHint": "create",
      "durabilityScore": 3,
      "authorityScore": 2,
      "reuseScore": 3,
      "noveltyScore": 2,
      "riskScore": 0
    }
  ]
}
```

Score fields are integers from 0 to 3. `actionHint` must be one of `create`, `update`, `merge`, `conflict`, or `skip`.
