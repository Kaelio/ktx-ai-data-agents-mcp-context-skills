export type ConnectionSelection =
  | { kind: 'all' }
  | { kind: 'single'; connectionId: string };

export interface ResolveConnectionSelectionInput {
  connectionId?: string | undefined;
  all: boolean;
}

export function resolveConnectionSelection(input: ResolveConnectionSelectionInput): ConnectionSelection {
  if (input.all && input.connectionId !== undefined) {
    throw new Error('--all cannot be combined with a connection id argument');
  }
  if (input.connectionId !== undefined) {
    return { kind: 'single', connectionId: input.connectionId };
  }
  return { kind: 'all' };
}
