import type { StagedCardFile, StagedParameter, StagedResultColumn, StagedTemplateTag } from './types.js';

const CARD_REF_RE = /\{\{#(\d+)\}\}/g;

/**
 * Input TemplateTag shape mirrors `MetabaseClient.getTemplateTags` output. We keep the
 * shape loose — only `name`, `type`, and optional `cardReference`/`default` are needed here.
 */
/** @internal */
export interface InputTemplateTag {
  name: string;
  type: string;
  cardReference?: number | null;
  defaultValue?: string | null;
}

/** @internal */
export function extractReferencedCardIds(templateTags: InputTemplateTag[], sql: string): number[] {
  const ids = new Set<number>();
  for (const tag of templateTags) {
    if (tag.type === 'card' && typeof tag.cardReference === 'number') {
      ids.add(tag.cardReference);
    }
  }
  for (const match of sql.matchAll(CARD_REF_RE)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) {
      ids.add(n);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Input card shape — matches the fields `MetabaseClient.getCard()` returns that we
 * care about. The adapter reads whatever the client returns; this helper stays
 * duck-typed so the client's type can evolve without churn here.
 */
interface InputCard {
  id: number;
  name: string;
  description?: string | null;
  type: string;
  database_id: number;
  collection_id?: number | 'root' | null;
  archived?: boolean;
  result_metadata?: Array<{
    name: string;
    display_name?: string | null;
    base_type: string;
    semantic_type?: string | null;
    description?: string | null;
    fk_target_field_id?: number | null;
    field_ref?: unknown[] | null;
  }> | null;
  parameters?: Array<{
    id: string;
    name: string;
    type: string;
    slug?: string | null;
    default?: unknown;
    sectionId?: string | null;
  }> | null;
  last_run_at?: string | null;
  dashboard_count?: number | null;
}

export interface SerializeCardParams {
  card: InputCard;
  resolvedSql: string;
  templateTags: InputTemplateTag[];
  collectionPath: string[];
  resolutionStatus: 'resolved' | 'fallback';
}

function toStagedColumn(col: NonNullable<InputCard['result_metadata']>[number]): StagedResultColumn {
  return {
    name: col.name,
    display_name: col.display_name ?? null,
    base_type: col.base_type,
    semantic_type: col.semantic_type ?? null,
    description: col.description ?? null,
    fk_target_field_id: col.fk_target_field_id ?? null,
    field_ref: col.field_ref ?? null,
  };
}

function toStagedParameter(param: NonNullable<InputCard['parameters']>[number]): StagedParameter {
  return {
    id: param.id,
    name: param.name,
    type: param.type,
    slug: param.slug ?? null,
    default: param.default ?? null,
    sectionId: param.sectionId ?? null,
  };
}

function toStagedTemplateTag(tag: InputTemplateTag): StagedTemplateTag {
  return {
    name: tag.name,
    type: tag.type,
    defaultValue: tag.defaultValue ?? null,
    cardReference: tag.cardReference ?? null,
  };
}

export function serializeCard(params: SerializeCardParams): StagedCardFile {
  const { card, resolvedSql, templateTags, collectionPath, resolutionStatus } = params;
  const referencedCardIds = extractReferencedCardIds(templateTags, resolvedSql);
  return {
    metabaseId: card.id,
    name: card.name,
    description: card.description ?? null,
    type: card.type,
    databaseId: card.database_id,
    collectionId: card.collection_id ?? null,
    archived: card.archived ?? false,
    resolvedSql,
    templateTags: templateTags.map(toStagedTemplateTag),
    resultMetadata: (card.result_metadata ?? []).map(toStagedColumn),
    collectionPath,
    referencedCardIds,
    parameters: (card.parameters ?? []).map(toStagedParameter),
    lastRunAt: card.last_run_at ?? null,
    dashboardCount: card.dashboard_count ?? null,
    resolutionStatus,
  };
}
