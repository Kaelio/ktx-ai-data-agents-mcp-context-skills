export interface SemanticLayerTargetPolicyInput {
  paths: readonly string[];
  allowedConnectionIds: ReadonlySet<string>;
}

/** @internal */
export interface SemanticLayerTargetPolicyViolation {
  path: string;
  connectionId: string;
}

/** @internal */
export function semanticLayerConnectionIdFromPath(path: string): string | null {
  const normalized = path.replace(/^[ab]\//, '');
  const match = /^semantic-layer\/([^/]+)\//.exec(normalized);
  return match?.[1] ?? null;
}

/** @internal */
export function findDisallowedSemanticLayerTargetPaths(
  input: SemanticLayerTargetPolicyInput,
): SemanticLayerTargetPolicyViolation[] {
  return input.paths
    .map((path) => ({ path, connectionId: semanticLayerConnectionIdFromPath(path) }))
    .filter((entry): entry is SemanticLayerTargetPolicyViolation => {
      return entry.connectionId !== null && !input.allowedConnectionIds.has(entry.connectionId);
    })
    .sort((left, right) => {
      const byConnection = left.connectionId.localeCompare(right.connectionId);
      return byConnection === 0 ? left.path.localeCompare(right.path) : byConnection;
    });
}

export function assertSemanticLayerTargetPathsAllowed(input: SemanticLayerTargetPolicyInput): void {
  const violations = findDisallowedSemanticLayerTargetPaths(input);
  if (violations.length === 0) {
    return;
  }
  const allowed = [...input.allowedConnectionIds].sort();
  throw new Error(
    `semantic-layer target connection not allowed: ${violations
      .map((violation) => `${violation.path} (${violation.connectionId})`)
      .join(', ')}; allowed: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
  );
}
