import { describe, expect, it } from 'vitest';
import { errorChain } from '../src/lib/error-chain.js';

describe('errorChain — текст ошибки с причинами', () => {
  it('«Failed query» drizzle показывает ответ Postgres из cause', () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "edo_export_cursors_pkey"'), {
      code: '23505',
    });
    const err = new Error('Failed query: insert into "edo_export_cursors" …', { cause: pg });
    expect(errorChain(err)).toBe(
      'Failed query: insert into "edo_export_cursors" …\n  причина: duplicate key value violates unique constraint "edo_export_cursors_pkey"',
    );
  });

  it('без причины — только сообщение; не Error — строкой; повтор и бесконечная цепочка не раздувают текст', () => {
    expect(errorChain(new Error('просто сбой'))).toBe('просто сбой');
    expect(errorChain('строка')).toBe('строка');
    const loop = new Error('петля');
    (loop as { cause?: unknown }).cause = loop;
    expect(errorChain(loop)).toBe('петля');
  });
});
