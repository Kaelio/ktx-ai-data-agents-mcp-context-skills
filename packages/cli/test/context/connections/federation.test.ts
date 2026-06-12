import { describe, expect, it } from 'vitest';
import {
  deriveFederatedConnection,
  FEDERATED_CONNECTION_ID,
} from '../../../src/context/connections/federation.js';

const conns = (entries: Record<string, { driver: string }>) => entries as never;

describe('deriveFederatedConnection', () => {
  it('returns null with zero compatible members', () => {
    expect(deriveFederatedConnection(conns({ snow: { driver: 'snowflake' } }))).toBeNull();
  });

  it('returns null with exactly one compatible member', () => {
    expect(deriveFederatedConnection(conns({ pg: { driver: 'postgres' } }))).toBeNull();
  });

  it('derives a descriptor with two compatible members', () => {
    const result = deriveFederatedConnection(
      conns({ pg: { driver: 'postgres' }, lite: { driver: 'sqlite' } }),
    );
    expect(result).not.toBeNull();
    expect(result?.id).toBe(FEDERATED_CONNECTION_ID);
    expect(result?.driver).toBe('duckdb');
    expect(result?.members.map((m) => m.connectionId).sort()).toEqual(['lite', 'pg']);
  });

  it('excludes incompatible members from the group', () => {
    const result = deriveFederatedConnection(
      conns({ pg: { driver: 'postgres' }, my: { driver: 'mysql' }, snow: { driver: 'snowflake' } }),
    );
    expect(result?.members.map((m) => m.connectionId).sort()).toEqual(['my', 'pg']);
  });

  it('is case-insensitive on driver names', () => {
    const result = deriveFederatedConnection(
      conns({ pg: { driver: 'POSTGRES' }, lite: { driver: 'SQLite' } }),
    );
    expect(result?.members).toHaveLength(2);
  });
});
