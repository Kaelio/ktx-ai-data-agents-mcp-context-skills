import { z } from 'zod';

export const tableUsageOutputSchema = z
  .object({
    narrative: z.string(),
    frequencyTier: z.enum(['high', 'mid', 'low', 'unused']),
    commonFilters: z.array(z.string()),
    commonGroupBys: z.array(z.string()).optional(),
    commonJoins: z.array(
      z.object({
        table: z.string(),
        on: z.array(z.string()),
      }),
    ),
    staleSince: z.iso.datetime().nullable().optional(),
  })
  .passthrough();
export type TableUsageOutput = z.infer<typeof tableUsageOutputSchema>;

export const patternOutputSchema = z.object({
  slug: z.string(),
  title: z.string(),
  narrative: z.string(),
  definitionSql: z.string(),
  tablesInvolved: z.array(z.string()),
  slRefs: z.array(z.string()),
  constituentTemplateIds: z.array(z.string()),
});

/** @internal */
export const patternsArraySchema = z.array(patternOutputSchema);
