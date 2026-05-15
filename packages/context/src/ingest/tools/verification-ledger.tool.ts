import { z } from 'zod';
import { createAgentTool, type AgentToolDefinition, type AgentToolSet } from '../../agent/index.js';

const verificationLedgerInputSchema = z.object({
  summary: z.string().min(1).max(2000),
  verifiedIdentifiers: z.array(z.string().min(1)).max(100).default([]),
  unverifiedIdentifiers: z.array(z.string().min(1)).max(100).default([]),
  notes: z.string().max(2000).optional(),
});

interface VerificationLedgerEntry {
  summary: string;
  verifiedIdentifiers: string[];
  unverifiedIdentifiers: string[];
  notes?: string;
}

export interface VerificationLedgerState {
  entries: VerificationLedgerEntry[];
}

const WRITE_TOOL_NAMES = new Set([
  'wiki_write',
  'wiki_remove',
  'sl_write_source',
  'sl_edit_source',
  'emit_unmapped_fallback',
]);

export const VERIFICATION_LEDGER_PROMPT = `<pre_write_verification>
Before any durable wiki, semantic-layer, or unmapped-fallback write (wiki_write, wiki_remove, sl_write_source, sl_edit_source, emit_unmapped_fallback), call record_verification_ledger.
The ledger is a model-authored checkpoint, not a deterministic parser gate. Summarize the verification protocol from the loaded skill, list identifiers verified with discover_data/entity_details/sql_execution, and list anything intentionally left unverified. If the write contains no warehouse identifiers, say that explicitly.
If a write tool returns verification_ledger_required, complete the ledger and retry the write.
</pre_write_verification>`;

export function createVerificationLedgerState(): VerificationLedgerState {
  return { entries: [] };
}

export function withVerificationLedger(tools: AgentToolSet, state: VerificationLedgerState): AgentToolSet {
  const wrapped: AgentToolSet = {};
  for (const [name, original] of Object.entries(tools)) {
    if (!WRITE_TOOL_NAMES.has(name)) {
      wrapped[name] = original;
      continue;
    }
    const guardedTool: AgentToolDefinition<any> = {
      ...original,
      execute: async (input, options) => {
        if (state.entries.length === 0) {
          return verificationRequiredOutput(name);
        }
        return original.execute(input, options);
      },
    };
    wrapped[name] = guardedTool;
  }
  wrapped.record_verification_ledger = createRecordVerificationLedgerTool(state);
  return wrapped;
}

function createRecordVerificationLedgerTool(state: VerificationLedgerState) {
  return createAgentTool({
    name: 'record_verification_ledger',
    description:
      'Record the pre-write verification ledger required by loaded ingest skills. Call this before wiki/SL/fallback writes to state what was verified, which tool calls support it, and what remains intentionally unverified.',
    inputSchema: verificationLedgerInputSchema,
    execute: async (input) => {
      const entry = verificationLedgerInputSchema.parse(input);
      state.entries.push(entry);
      return {
        markdown:
          `Verification ledger recorded. Summary: ${entry.summary}\n` +
          `Verified identifiers: ${entry.verifiedIdentifiers.length ? entry.verifiedIdentifiers.join(', ') : '(none)'}\n` +
          `Unverified identifiers: ${
            entry.unverifiedIdentifiers.length ? entry.unverifiedIdentifiers.join(', ') : '(none)'
          }`,
        structured: { success: true, entry },
      };
    },
  });
}

function verificationRequiredOutput(toolName: string) {
  return {
    markdown:
      `Pre-write verification required before calling ${toolName}. ` +
      'Call record_verification_ledger first. In the ledger, summarize the loaded skill protocol you followed, ' +
      'list identifiers verified via discover_data/entity_details/sql_execution, and list any identifiers intentionally left unverified. ' +
      'If the write contains no warehouse identifiers, say that explicitly in the ledger summary.',
    structured: {
      success: false,
      reason: 'verification_ledger_required',
      toolName,
    },
  };
}
