import type { MemoryAction } from '../tools/index.js';
import { isFlatWikiKey } from './keys.js';
import type { KnowledgeWikiService } from './knowledge-wiki.service.js';
import type { WikiScope } from './types.js';

function isWikiPageKeyRef(ref: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*(?:-[a-z0-9_]+)*$/.test(ref);
}

function extractInlineWikiRefs(content: string): string[] {
  const refs = new Set<string>();
  const re = /\[\[([^\]\n]+)\]\]/g;
  for (const match of content.matchAll(re)) {
    const target = match[1]?.split('|', 1)[0]?.trim();
    if (target && isWikiPageKeyRef(target)) {
      refs.add(target);
    }
  }
  return [...refs].sort();
}

async function visibleWikiPageKeys(
  wikiService: KnowledgeWikiService,
  scope: WikiScope,
  scopeId: string | null,
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (scope === 'USER') {
    for (const key of await wikiService.listPageKeys('GLOBAL', null)) {
      keys.add(key);
    }
    for (const key of await wikiService.listPageKeys('USER', scopeId)) {
      keys.add(key);
    }
    return keys;
  }

  for (const key of await wikiService.listPageKeys('GLOBAL', null)) {
    keys.add(key);
  }
  return keys;
}

export async function findMissingWikiRefs(input: {
  wikiService: KnowledgeWikiService;
  scope: WikiScope;
  scopeId: string | null;
  pageKey: string;
  refs?: string[];
  content: string;
}): Promise<string[]> {
  const candidates = new Set<string>();
  for (const ref of input.refs ?? []) {
    if (isWikiPageKeyRef(ref)) {
      candidates.add(ref);
    }
  }
  for (const ref of extractInlineWikiRefs(input.content)) {
    candidates.add(ref);
  }

  if (candidates.size === 0) {
    return [];
  }

  const available = await visibleWikiPageKeys(input.wikiService, input.scope, input.scopeId);
  available.add(input.pageKey);
  return [...candidates].filter((ref) => !available.has(ref)).sort();
}

export async function findDanglingWikiRefsForActions(input: {
  wikiService: KnowledgeWikiService;
  scope: WikiScope;
  scopeId: string | null;
  actions: MemoryAction[];
}): Promise<string[]> {
  const latestWikiActionByKey = new Map<string, MemoryAction['type']>();
  for (const action of input.actions) {
    if (action.target === 'wiki' && isFlatWikiKey(action.key)) {
      latestWikiActionByKey.set(action.key, action.type);
    }
  }

  const dangling: string[] = [];
  for (const [pageKey, actionType] of [...latestWikiActionByKey.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (actionType === 'removed') {
      continue;
    }
    const page = await input.wikiService.readPage(input.scope, input.scopeId, pageKey);
    if (!page) {
      dangling.push(`${pageKey} -> (missing page)`);
      continue;
    }
    const missingRefs = await findMissingWikiRefs({
      wikiService: input.wikiService,
      scope: input.scope,
      scopeId: input.scopeId,
      pageKey,
      refs: page.frontmatter.refs,
      content: page.content,
    });
    for (const missingRef of missingRefs) {
      dangling.push(`${pageKey} -> ${missingRef}`);
    }
  }
  return dangling;
}
