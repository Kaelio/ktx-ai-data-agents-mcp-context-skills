import { describe, expect, it } from 'vitest';
import { federationNoticeFor } from '../src/setup-databases.js';

describe('federationNoticeFor', () => {
  it('returns a notice naming members when 2+ compatible exist', () => {
    const notice = federationNoticeFor({
      pg_books: { driver: 'postgres' },
      sqlite_reviews: { driver: 'sqlite' },
    } as never, '/proj');
    expect(notice).toMatch(/pg_books/);
    expect(notice).toMatch(/sqlite_reviews/);
    expect(notice).toMatch(/cross-database/i);
  });

  it('returns null with fewer than 2 compatible', () => {
    expect(federationNoticeFor({ pg: { driver: 'postgres' } } as never, '/proj')).toBeNull();
  });

  it('returns null when the second db is incompatible', () => {
    expect(
      federationNoticeFor({ pg: { driver: 'postgres' }, snow: { driver: 'snowflake' } } as never, '/proj'),
    ).toBeNull();
  });
});
