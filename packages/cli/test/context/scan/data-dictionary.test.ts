import { describe, expect, it } from 'vitest';
import {
  defaultKtxDataDictionarySettings,
  isKtxDataDictionaryCandidate,
  shouldKtxSampleColumnForDictionary,
} from '../../../src/context/scan/data-dictionary.js';

const defaultPatterns = defaultKtxDataDictionarySettings.excludePatterns;

describe('ktx scan data dictionary policy', () => {
  it('includes text-like and boolean categorical types', () => {
    expect(isKtxDataDictionaryCandidate('varchar(50)', 'status', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('VARCHAR', 'category', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('text', 'region', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('string', 'payment_method', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('nvarchar(100)', 'tier', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('enum', 'status', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('boolean', 'active', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('bool', 'verified', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('character varying(50)', 'region', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('character(1)', 'flag', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('ntext', 'category', defaultPatterns)).toBe(true);
  });

  it('excludes non-categorical primitive types', () => {
    expect(isKtxDataDictionaryCandidate('integer', 'count', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('bigint', 'total', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('timestamp', 'created', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('date', 'birth', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('numeric', 'amount', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('decimal(10,2)', 'price', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('float', 'rate', defaultPatterns)).toBe(false);
  });

  it('excludes configured high-cardinality or sensitive name patterns', () => {
    expect(isKtxDataDictionaryCandidate('varchar', 'user_id', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'session_uuid', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'api_key', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'password_hash', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'auth_token', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'id', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'created_at', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'birth_date', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('text', 'description', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('text', 'email_body', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'image_url', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'email', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'phone_number', defaultPatterns)).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'street_address', defaultPatterns)).toBe(false);
  });

  it('keeps business categorical names eligible', () => {
    expect(isKtxDataDictionaryCandidate('varchar', 'status', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'region', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'country', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'payment_method', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'currency', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'plan', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'category', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'tier', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'gender', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'language', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'order_type', defaultPatterns)).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'order_status', defaultPatterns)).toBe(true);
  });

  it('respects host-provided exclusion patterns and skips invalid regex patterns', () => {
    expect(isKtxDataDictionaryCandidate('varchar', 'company_size', ['company'])).toBe(false);
    expect(isKtxDataDictionaryCandidate('varchar', 'status', ['company'])).toBe(true);
    expect(isKtxDataDictionaryCandidate('varchar', 'status', ['[invalid', '(unclosed'])).toBe(true);
  });

  it('skips columns that already have persisted dictionary state', () => {
    expect(
      shouldKtxSampleColumnForDictionary({
        columnType: 'varchar',
        columnName: 'status',
        sampleValues: ['paid'],
        cardinality: null,
        settings: defaultKtxDataDictionarySettings,
      }),
    ).toEqual({ sample: false, reason: 'already_populated' });

    expect(
      shouldKtxSampleColumnForDictionary({
        columnType: 'varchar',
        columnName: 'empty_status',
        sampleValues: null,
        cardinality: 0,
        settings: defaultKtxDataDictionarySettings,
      }),
    ).toEqual({ sample: false, reason: 'empty_column' });

    expect(
      shouldKtxSampleColumnForDictionary({
        columnType: 'varchar',
        columnName: 'customer_name',
        sampleValues: null,
        cardinality: 300,
        settings: defaultKtxDataDictionarySettings,
      }),
    ).toEqual({ sample: false, reason: 'high_cardinality' });

    expect(
      shouldKtxSampleColumnForDictionary({
        columnType: 'varchar',
        columnName: 'status',
        sampleValues: null,
        cardinality: null,
        settings: defaultKtxDataDictionarySettings,
      }),
    ).toEqual({ sample: true });
  });
});
