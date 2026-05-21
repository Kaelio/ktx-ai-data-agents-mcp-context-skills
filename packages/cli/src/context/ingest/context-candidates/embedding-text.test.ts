import { describe, expect, it } from 'vitest';
import { buildContextCandidateEmbeddingText } from './embedding-text.js';

describe('buildContextCandidateEmbeddingText', () => {
  it('matches the existing dedup embedding input format', () => {
    expect(
      buildContextCandidateEmbeddingText({
        topic: 'Revenue Recognition',
        assertion: 'Booked revenue excludes refunds and test accounts.',
      }),
    ).toBe('Revenue Recognition - Booked revenue excludes refunds and test accounts.');
  });
});
