/**
 * Идемпотентный перенос API-ключей из llm_providers в llm_provider_credentials.
 *
 * До миграции 0020 каждый kind хранил ключ per-строка. Эта функция один раз
 * (и любое число повторов — безопасно) переносит ключ для каждого kind,
 * у которого ещё нет credential, перешифровывая под новый AAD.
 *
 * Источник для kind — запись с непустым ключом, default-ная важнее остальных.
 * Запускается из scripts/migrate.ts сразу после применения всех миграций.
 */
import type { Sql } from 'postgres';
import { decryptField, encryptToString, buildAad } from '../domain/auth/crypto.js';

type LegacyRow = {
  id: string;
  api_base_url: string | null;
  api_key_encrypted: string | null;
};

const KINDS = ['openrouter', 'google_ai_studio', 'qwen_self_hosted', 'vertex'] as const;

export async function backfillProviderCredentials(sql: Sql): Promise<void> {
  for (const kind of KINDS) {
    const existing = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "llm_provider_credentials" WHERE "kind" = ${kind}
      ) AS "exists"
    `;
    if (existing[0]?.exists) continue;

    const rows = await sql<LegacyRow[]>`
      SELECT "id", "api_base_url", "api_key_encrypted"
      FROM "llm_providers"
      WHERE "kind" = ${kind}
        AND "api_key_encrypted" IS NOT NULL
        AND "api_base_url" IS NOT NULL
      ORDER BY "is_default" DESC, "created_at" ASC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || !row.api_key_encrypted || !row.api_base_url) continue;

    let plaintext: string;
    try {
      plaintext = decryptField(row.api_key_encrypted, buildAad('llm_providers', row.id));
    } catch (err) {
      console.warn(
        `[backfill] kind=${kind}: не удалось расшифровать ключ из llm_providers.id=${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }. Пропускаю — задайте ключ через UI.`,
      );
      continue;
    }
    const encrypted = encryptToString(plaintext, buildAad('llm_provider_credentials', kind));

    await sql`
      INSERT INTO "llm_provider_credentials" ("kind", "api_base_url", "api_key_encrypted")
      VALUES (${kind}, ${row.api_base_url}, ${encrypted})
      ON CONFLICT ("kind") DO NOTHING
    `;
    console.info(`[backfill] kind=${kind}: ключ перенесён из llm_providers.id=${row.id}`);
  }
}
