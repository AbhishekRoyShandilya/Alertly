import { describe, expect, it } from 'vitest';
import { decodeId, encodeId } from '../../src/lib/ids';
import { cursorWhere, decodeCursor, encodeCursor, toPage } from '../../src/lib/pagination';
import { AppError } from '../../src/lib/errors';

describe('public ids', () => {
  it('round-trips', () => {
    for (const n of [1, 61, 62, 12345, Number.MAX_SAFE_INTEGER]) {
      expect(decodeId('ntf', encodeId('ntf', n))).toBe(n);
    }
    expect(encodeId('ch', 62)).toBe('ch_10');
  });

  it('rejects the wrong prefix or garbage with 404', () => {
    const wrongType = () => decodeId('ntf', encodeId('ch', 5));
    expect(wrongType).toThrow(AppError);
    for (const bad of ['ntf_', 'ntf_!!', 'ntf', 'ntf_1_2', 'ntf_0', 'ntf_zzzzzzzzzzzzzz']) {
      expect(() => decodeId('ntf', bad), bad).toThrow(AppError);
    }
  });
});

describe('cursor pagination', () => {
  it('round-trips a cursor', () => {
    const c = { createdAt: new Date('2026-10-16T09:31:02.114Z'), id: 42 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('rejects a tampered cursor with 400', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(AppError);
  });

  it('builds a seek clause', () => {
    const cursor = encodeCursor({ createdAt: new Date('2026-01-01T00:00:00Z'), id: 7 });
    const w = cursorWhere(cursor, 'n');
    expect(w.sql).toContain('n.created_at < ?');
    expect(w.params).toHaveLength(3);
    expect(cursorWhere(undefined, 'n').sql).toBe('');
  });

  it('toPage returns a next cursor only when there are more rows', () => {
    const rows = [3, 2, 1].map((id) => ({ id, created_at: new Date(id * 1000) }));
    const page = toPage(rows, 2, (r) => r.id);
    expect(page.data).toEqual([3, 2]);
    expect(decodeCursor(page.nextCursor!).id).toBe(2);
    expect(toPage(rows, 3, (r) => r.id).nextCursor).toBeNull();
  });
});
