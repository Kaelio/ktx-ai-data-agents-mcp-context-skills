import { describe, expect, it } from 'vitest';
import {
  assertSemanticLayerTargetPathsAllowed,
  findDisallowedSemanticLayerTargetPaths,
  semanticLayerConnectionIdFromPath,
} from '../../../src/context/ingest/semantic-layer-target-policy.js';

describe('semantic-layer target policy', () => {
  it('extracts connection ids from semantic-layer paths', () => {
    expect(semanticLayerConnectionIdFromPath('semantic-layer/warehouse/orders.yaml')).toBe('warehouse');
    expect(semanticLayerConnectionIdFromPath('a/semantic-layer/finance/orders.yaml')).toBe('finance');
    expect(semanticLayerConnectionIdFromPath('wiki/global/orders.md')).toBeNull();
  });

  it('finds semantic-layer paths outside the allowed target connections', () => {
    expect(
      findDisallowedSemanticLayerTargetPaths({
        paths: [
          'semantic-layer/warehouse/orders.yaml',
          'semantic-layer/finance/orders.yaml',
          'wiki/global/orders.md',
        ],
        allowedConnectionIds: new Set(['warehouse']),
      }),
    ).toEqual([{ path: 'semantic-layer/finance/orders.yaml', connectionId: 'finance' }]);
  });

  it('throws a deterministic error for unauthorized semantic-layer targets', () => {
    expect(() =>
      assertSemanticLayerTargetPathsAllowed({
        paths: ['semantic-layer/finance/orders.yaml', 'semantic-layer/marketing/accounts.yaml'],
        allowedConnectionIds: new Set(['warehouse']),
      }),
    ).toThrow(
      /semantic-layer target connection not allowed: semantic-layer\/finance\/orders\.yaml \(finance\), semantic-layer\/marketing\/accounts\.yaml \(marketing\); allowed: warehouse/,
    );
  });
});
