// ─────────────────────────────────────────────────────────────────────────
// DEBUG-ONLY скрипт (НЕ часть production flow).
//
// Прогоняет многостраничный УПД-скан через:
//   prefilterUpdPages  → классификация + авто-поворот страниц
//   segmentUpdPages    → нарезка на УПД-документы по границам upd_main
//   [TODO]             → extract каждой группы Vision'ом + aggregateUpdDocuments
//
// Запуск (в окружении API, где есть БД и LLM-креды):
//   pnpm --filter @matcheck/api exec tsx scripts/debug-multi-upd-pdf.ts [путь.pdf]
// По умолчанию путь = docs/debug-upd/сканирование0202.pdf
//
// Только ЧИТАЕТ из БД (default LLM-провайдер + ключ). Ничего не пишет:
// ни source_documents, ни llm_calls. Цель — глазами убедиться, что
// 4-страничный скан режется на 4 УПД и страницы не смешиваются.
// ─────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { llmProviders, llmProviderCredentials } from '../src/db/schema.js';
import { buildAad, decryptField } from '../src/domain/auth/crypto.js';
import { prefilterUpdPages } from '../src/domain/edo/upd-page-prefilter.js';
import { MAX_PAGES_FOR_OPENROUTER } from '../src/domain/edo/upd-vision.parser.js';
import { segmentUpdPages } from '../src/domain/edo/upd-batch.parser.js';

const DEFAULT_PDF = 'docs/debug-upd/сканирование0202.pdf';
// Корень репозитория: apps/api/scripts → ../../.. (скрипт запускается из
// apps/api, поэтому дефолтный путь привязываем к расположению файла, а не cwd).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function main(): Promise<void> {
  const argPath = process.argv[2];
  // Явный аргумент — относительно cwd; дефолт — относительно корня репозитория.
  const pdfPath = argPath
    ? resolve(process.cwd(), argPath)
    : resolve(REPO_ROOT, DEFAULT_PDF);
  console.log(`\n=== debug multi-UPD PDF ===\nфайл: ${pdfPath}\n`);

  const pdfBuffer = await readFile(pdfPath);
  console.log(`размер: ${pdfBuffer.length} байт`);

  // ── default LLM-провайдер + ключ (read-only) ──
  const [provider] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!provider) {
    console.error('Нет default LLM-провайдера — prefilter без классификации деградирует к первым страницам.');
    process.exit(1);
  }
  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, provider.kind))
    .limit(1);
  if (!cred) {
    console.error(`Нет ключа провайдера ${provider.kind}.`);
    process.exit(1);
  }
  const apiKey = decryptField(
    cred.apiKeyEncrypted,
    buildAad('llm_provider_credentials', cred.kind),
  );
  console.log(`провайдер: ${provider.kind} / модель: ${provider.model}\n`);

  // ── prefilter: классификация + поворот ──
  const prefilter = await prefilterUpdPages(pdfBuffer, {
    apiBaseUrl: cred.apiBaseUrl,
    apiKey,
    model: provider.model,
    maxPages: MAX_PAGES_FOR_OPENROUTER,
  });

  console.log('── prefilter ──');
  console.log(`всего страниц отрендерено: ${prefilter.totalPages}`);
  console.log(`классификация LLM выполнялась: ${prefilter.classifyRan}`);
  console.log(`деградация (УПД не найден классиф.): ${prefilter.fellBack}`);
  console.log(`/Rotate из PDF по страницам: [${prefilter.perPageRotateFlag.join(', ')}]`);
  console.log('классификация по страницам:');
  for (const c of prefilter.classification) {
    console.log(`  стр.${c.page}: type=${c.type} use=${c.use}`);
  }
  console.log(`выбранные страницы (selectedPages): [${prefilter.selectedPages.join(', ')}]`);
  console.log(`применённые повороты (deg): [${prefilter.rotations.join(', ')}]`);

  // ── segment: нарезка на УПД ──
  const segments = segmentUpdPages(prefilter.classification, prefilter.selectedPages);
  console.log(`\n── segments (УПД-документы): ${segments.length} ──`);
  for (const s of segments) {
    console.log(
      `  #${s.segmentIndex}: страницы [${s.pages.join(', ')}] · ${s.confidence}` +
        (s.reasons.length ? ` · ${s.reasons.join('; ')}` : ''),
    );
  }

  // ── TODO: extract per segment + aggregate ──
  // Извлечение каждой группы Vision'ом сейчас потребовало бы рефактора
  // production parseUpdVision (он завязан на БД-провайдеры и делает
  // prefilter+extract единым непубличным блоком). Делать это в Шаге 1
  // рискованно. Следующий шаг:
  //   1) вынести из parseUpdVision минимальный extract(pages: Buffer[]) helper
  //      БЕЗ изменения текущего одиночного flow;
  //   2) для каждого segment взять prefilter.pages по его номерам страниц,
  //      вызвать extract → ParsedUpdSubdocument;
  //   3) aggregateUpdDocuments(subdocs) → одна агрегированная строка
  //      (docNumber «487, 488, 489, 490», merged items, subdocs-meta).
  console.log(
    '\n[TODO] extract-per-segment + aggregateUpdDocuments — следующий шаг ' +
      '(нужен безопасный helper extract(pages[]) из parseUpdVision, без правки одиночного flow).',
  );

  console.log('\n=== готово ===\n');
}

main()
  .then(async () => {
    await sql.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('debug-multi-upd-pdf упал:', err);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    process.exit(1);
  });
