/**
 * Регрессия на дефект 42P10 в приёме заявок из почты.
 *
 * `source_mail_message_unique` — ЧАСТИЧНЫЙ индекс (`where mail_account_id is
 * not null`). PostgreSQL сопоставляет `ON CONFLICT` с частичным индексом
 * только когда в запросе повторён его предикат; иначе — ошибка 42P10 «there is
 * no unique or exclusion constraint matching the ON CONFLICT specification»,
 * и падает КАЖДОЕ письмо.
 *
 * Здесь проверяется сам генерируемый SQL — без БД, поэтому тест работает в
 * обычном `pnpm test`. Поведение на живом PostgreSQL закрыто интеграционным
 * набором `test/integration/mail-requests.int.test.ts`.
 */
import { sql as drSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { sourceDocuments } from '../src/db/schema.js';

// Клиент не подключается, пока запрос не выполнен: ниже вызывается только
// toSQL(), поэтому адрес заведомо нерабочий.
const client = postgres('postgres://postgres@127.0.0.1:1/none', { max: 1 });
const db = drizzle(client);

afterAll(async () => {
  await client.end({ timeout: 0 });
});

describe('ON CONFLICT для писем-заявок', () => {
  const insert = () =>
    db.insert(sourceDocuments).values({
      kind: 'request',
      direction: 'inbound',
      origin: 'mail',
      mailAccountId: '00000000-0000-0000-0000-000000000001',
      messageId: '<test@example.org>',
      status: 'parsed',
    });

  it('повторяет предикат частичного индекса', () => {
    const { sql } = insert()
      .onConflictDoNothing({
        target: [sourceDocuments.mailAccountId, sourceDocuments.messageId],
        where: drSql`${sourceDocuments.mailAccountId} is not null`,
      })
      .toSQL();

    expect(sql).toContain('on conflict');
    expect(sql).toContain('mail_account_id');
    expect(sql).toContain('message_id');
    // Ключевое: между списком колонок и `do nothing` обязан стоять предикат.
    expect(sql).toMatch(/on conflict \([^)]*\)\s+where\s+.*do nothing/i);
  });

  it('без предиката SQL не соответствует частичному индексу', () => {
    // Фиксируем форму запроса, которая приводила к 42P10 — чтобы правка,
    // потерявшая `where`, отличалась от корректной не только на глаз.
    const { sql } = insert()
      .onConflictDoNothing({
        target: [sourceDocuments.mailAccountId, sourceDocuments.messageId],
      })
      .toSQL();

    expect(sql).not.toMatch(/on conflict \([^)]*\)\s+where/i);
  });
});
