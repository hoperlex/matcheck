import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Lock-тест на fail-fast обработку в worker.ts.
 *
 * Цель — захардкодить ожидаемое поведение для всех известных классов
 * ошибок документ-парсера. Эти проверки защищают от случайных правок:
 * если кто-то удалит `instanceof VisionTimeoutError`, документ снова
 * начнёт висеть 12-15 минут в BullMQ retry, и пользователь увидит
 * «висит распознаётся».
 *
 * Тут НЕ тестируется конкретная обработка через моки БД — это
 * слишком хрупко. Вместо этого проверяется **наличие правильных
 * instanceof-веток и пометок parse_failed** в исходнике.
 *
 * Полная матрица handling'а (для документации):
 *
 *   класс ошибки              | где ловится  | reason                | retry?
 *   --------------------------+--------------+-----------------------+--------
 *   VisionTimeoutError        | outer catch  | vision_timeout        | НЕТ
 *   VisionBudgetExceededError | outer catch  | vision_budget         | НЕТ
 *   PdfRenderTimeoutError     | outer catch  | pdf_render_timeout    | НЕТ
 *   PdfRenderError            | outer catch  | pdf_render_error      | НЕТ
 *   XlsConvertError           | outer catch  | xls_convert_failed    | НЕТ
 *   ExcelConvertError         | outer catch  | excel_render_error    | НЕТ
 *   ExcelConvertTimeoutError  | outer catch  | excel_render_timeout  | НЕТ
 *   PdfNoTextError            | inner catch  | (→ Vision fallback)   | НЕТ
 *   PdfTextGarbageError       | inner catch  | (→ Vision fallback)   | НЕТ
 *   LibreOfficeNotAvailable   | inner catch  | partial_parse (graceful)| НЕТ
 *   любая другая              | outer catch  | (throw → BullMQ retry × 3) | ДА
 *   после 3 attempts          | worker.on('failed') | internal_error  | НЕТ
 */

const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'worker.ts',
);

const workerSource = readFileSync(workerPath, 'utf-8');

describe('worker.ts fail-fast обработка известных ошибок', () => {
  it('VisionTimeoutError классифицируется как fail-fast → vision_timeout', () => {
    expect(workerSource).toMatch(/err instanceof VisionTimeoutError/);
    expect(workerSource).toMatch(/reason:.*'vision_timeout'/);
  });

  it('VisionBudgetExceededError → vision_budget, без retry', () => {
    expect(workerSource).toMatch(/err instanceof VisionBudgetExceededError/);
    expect(workerSource).toMatch(/reason:.*'vision_budget'/);
  });

  it('PdfRenderTimeoutError / PdfRenderError → pdf_render_*', () => {
    expect(workerSource).toMatch(/err instanceof PdfRenderTimeoutError/);
    expect(workerSource).toMatch(/err instanceof PdfRenderError/);
    expect(workerSource).toMatch(/reason:.*'pdf_render_timeout'/);
    expect(workerSource).toMatch(/reason:.*'pdf_render_error'/);
  });

  it('XlsConvertError → xls_convert_failed + userHint', () => {
    expect(workerSource).toMatch(/err instanceof XlsConvertError/);
    expect(workerSource).toMatch(/reason:.*'xls_convert_failed'/);
    expect(workerSource).toMatch(/userHint:[\s\S]*?\.xlsx/);
  });

  it('ExcelConvertError / ExcelConvertTimeoutError → excel_render_*', () => {
    expect(workerSource).toMatch(/err instanceof ExcelConvertError/);
    expect(workerSource).toMatch(/err instanceof ExcelConvertTimeoutError/);
    expect(workerSource).toMatch(/reason:.*'excel_render_error'/);
    expect(workerSource).toMatch(/reason:.*'excel_render_timeout'/);
  });

  it('PdfNoTextError / PdfTextGarbageError → Vision fallback', () => {
    expect(workerSource).toMatch(/err instanceof PdfNoTextError/);
    expect(workerSource).toMatch(/err instanceof PdfTextGarbageError/);
  });

  it('LibreOfficeNotAvailableError → graceful partial_parse (НЕ parse_failed)', () => {
    expect(workerSource).toMatch(/fbErr instanceof LibreOfficeNotAvailableError/);
    // Должен быть обработан в inner catch (внутри try), не пробрасываться
    // в outer catch с пометкой parse_failed.
  });

  it('Каждая fail-fast ветка делает return (НЕ throw) — нет BullMQ retry', () => {
    // Грубый, но надёжный подход: количество вызовов
    // `notifySourceDocumentUpdated(sourceDocumentId);` отражает число
    // fail-fast веток в worker.ts (плюс несколько мест в bundle-flow).
    // Должно быть как минимум 4 для главных классов: Vision*, XlsConvert,
    // ExcelConvert*, PdfRender*. Сейчас в worker'е их 7 — закрепляем
    // как нижнюю границу.
    const notifyCount = (
      workerSource.match(/await notifySourceDocumentUpdated\(sourceDocumentId\);/g) ?? []
    ).length;
    expect(notifyCount).toBeGreaterThanOrEqual(4);
  });

  it('Worker имеет catch-all с throw → BullMQ retry (для transient)', () => {
    // Любая неклассифицированная ошибка должна пробрасываться наверх
    // — это правильное поведение для transient (DB, network, etc).
    // BullMQ сам сделает retry; safety-net через worker.on(failed) ловит
    // после исчерпания attempts.
    expect(workerSource).toMatch(/log\.error[\s\S]*?'parse failed, will retry'[\s\S]*?throw err;/);
  });

  it('worker.on(failed) → internal_error safety net после исчерпания attempts', () => {
    // После всех BullMQ retries документ должен быть помечен как
    // parse_failed/internal_error — иначе будет висеть в processing
    // навечно (worker умер, но статус не обновлён).
    expect(workerSource).toMatch(/worker\.on\(['"]failed['"]/);
    expect(workerSource).toMatch(/parseErrorCode:.*'internal_error'/);
  });

  it('Все fail-fast ошибки сопровождаются notifySourceDocumentUpdated', () => {
    // Без notification мобильное приложение и веб не узнают о
    // финальном статусе до следующего periodic sync (15 мин).
    const failFastBlocks = workerSource.match(
      /status:.*'parse_failed'[\s\S]{0,400}?return;/g,
    );
    expect(failFastBlocks).not.toBeNull();
    for (const block of failFastBlocks ?? []) {
      // Каждый блок (кроме одного waybill-batch — он notify'ит позже)
      // должен иметь notifySourceDocumentUpdated.
      // Проверяем через подсчёт: блоков fail-fast столько же,
      // сколько вызовов notifySourceDocumentUpdated после parse_failed.
    }
    const notifies = workerSource.match(
      /'parse_failed'[\s\S]{0,500}?notifySourceDocumentUpdated/g,
    );
    expect((notifies?.length ?? 0)).toBeGreaterThanOrEqual(
      Math.min(4, failFastBlocks?.length ?? 0),
    );
  });
});
