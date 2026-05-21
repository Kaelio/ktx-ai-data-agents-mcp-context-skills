type FetchCardFn = (cardId: number) => Promise<{ native_query: string }>;

export class CardReferenceCycleError extends Error {
  constructor(
    public readonly cardId: number,
    public readonly path: number[],
  ) {
    super(`Cycle detected in Metabase card references at card ${cardId} (path: ${path.join(' -> ')})`);
    this.name = 'CardReferenceCycleError';
  }
}

const CARD_REFERENCE_PATTERN = /\{\{#(\d+)(?:-[^}]+)?\}\}/g;

export async function expandCardReferences(
  sql: string,
  opts: { fetchCard: FetchCardFn; visited?: Set<number> },
): Promise<string> {
  const visited = opts.visited ?? new Set<number>();
  const matches = Array.from(sql.matchAll(CARD_REFERENCE_PATTERN));
  if (matches.length === 0) {
    return sql;
  }

  const resolved = await Promise.all(
    matches.map(async (match) => {
      const cardId = Number(match[1]);
      if (visited.has(cardId)) {
        throw new CardReferenceCycleError(cardId, [...visited, cardId]);
      }
      const nextVisited = new Set(visited);
      nextVisited.add(cardId);
      const card = await opts.fetchCard(cardId);
      const expandedInner = await expandCardReferences(card.native_query, {
        fetchCard: opts.fetchCard,
        visited: nextVisited,
      });
      return { match: match[0], expanded: expandedInner };
    }),
  );

  let output = sql;
  for (const { match, expanded } of resolved) {
    output = output.split(match).join(`(${expanded})`);
  }
  return output;
}
