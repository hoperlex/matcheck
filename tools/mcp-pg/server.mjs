#!/usr/bin/env node
// Локальный stdio-MCP: read-only доступ к Postgres MatCheck для диагностики.
// Строка подключения — только из env MATCHECK_DB_RO_URL. Пишет физически нельзя
// (SELECT-only юзер + read-only транзакции + guardrails, см. db.mjs).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, runReadOnlyQuery } from './db.mjs';

const db = openDb(process.env.MATCHECK_DB_RO_URL);

// JSON-сериализация с учётом типов, которые отдаёт postgres-js.
function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value && value.constructor && value.constructor.name === 'Buffer') {
    return `<buffer ${value.length}b>`;
  }
  return value;
}

function formatResult(res) {
  const header =
    `rowCount=${res.rowCount}` +
    (res.limited ? ' (авто-LIMIT применён)' : '') +
    (res.columns.length ? ` columns=[${res.columns.join(', ')}]` : '');
  return `${header}\n${JSON.stringify(res.rows, jsonReplacer, 2)}`;
}

const server = new McpServer({ name: 'matcheck-db', version: '1.0.0' });

server.tool(
  'query',
  'Выполнить read-only SQL (SELECT/WITH) к боевой БД MatCheck. Только один стейтмент; ' +
    'авто-LIMIT 500 если лимита нет; `SELECT *` без WHERE/LIMIT запрещён. Держи запросы узкими ' +
    '(по объекту/датам/инспекторам). Ключевые сигналы: delivery_photos.uploaded_at IS NULL = ' +
    'фото висит; sessions.last_seen_at/last_seen_ua = последний контакт устройства; статусы ' +
    'приёмок — join statuses по deliveries.status_id.',
  { sql: z.string().describe('Один SELECT/WITH-запрос') },
  async ({ sql: queryText }) => {
    try {
      const res = await runReadOnlyQuery(db, queryText);
      return { content: [{ type: 'text', text: formatResult(res) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Ошибка: ${err.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'list_tables',
  'Список таблиц схемы public с числом колонок (для ориентира в схеме).',
  {},
  async () => {
    try {
      const res = await runReadOnlyQuery(
        db,
        `SELECT table_name, count(*) AS columns
         FROM information_schema.columns
         WHERE table_schema = 'public'
         GROUP BY table_name
         ORDER BY table_name`,
      );
      return { content: [{ type: 'text', text: formatResult(res) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Ошибка: ${err.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
