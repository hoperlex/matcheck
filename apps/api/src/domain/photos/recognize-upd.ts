import { eq } from 'drizzle-orm';
import type { PhotoRecognitionItem, UpdPdfParsed, UpdValidation } from '@matcheck/contracts';
import { db } from '../../db/client.js';
import { llmProviders } from '../../db/schema.js';
import { normalizeLineVatAgainstHeader } from '../edo/vat-rate-normalize.js';
import { normalizeUpdNoPricingTotals } from '../edo/upd-no-pricing-normalize.js';
import { parseUpdVision } from '../edo/upd-vision.parser.js';
import { synthesizeTotalSum } from '../edo/upd-outcome.js';
import { validateUpdTotals } from '../edo/upd-validation.js';
import {
  applyQtyRepairs,
  buildQtyRepairTrace,
  detectQtyRepairs,
  type QtyRepairTrace,
} from '../edo/qty-repair.js';
import { loadEnv } from '../../lib/env.js';

/**
 * Разбор фото УПД для split-view в Принятых — тем же путём, что и основной
 * конвейер документов.
 *
 * Зачем отдельный модуль, а не прямой вызов parseUpdVision из роута.
 * Распознавание в воркере — это не один вызов парсера, а цепочка: после него
 * идут две нормализации и сверка, причём сверка обязана считаться ПОСЛЕ них
 * (см. worker.ts, ветка handleJob). Роут, зовущий парсер напрямую, получил бы
 * сырой ответ модели и обошёл всё, что на основном пути уже вылечено —
 * построчный НДС, противоречащий шапке, и документы без стоимостной части.
 * Тогда обещание «исправления основного пути приезжают сюда автоматически»
 * было бы неправдой.
 *
 * Чего этот адаптер НЕ делает: не решает судьбу документа. `deriveUpdParseOutcome`
 * с его `parsed` / `needs_resolution` относится к source_documents, а у кэша
 * фото статуса нет — есть только показ менеджеру. Из той логики берётся ровно
 * одно: синтез итога по строкам, когда «Всего к оплате» не пропечаталось.
 */
export type PhotoUpdRecognition = {
  items: PhotoRecognitionItem[];
  docNumber: string | null;
  docDate: string | null;
  totalSum: number | null;
  vatSum: number | null;
  itemsCount: number | null;
  confidence: number | null;
  model: string | null;
  validation: UpdValidation;
  /**
   * След правила восстановления количества — служебный, карточка его не
   * показывает. null, когда кандидатов не было или правило выключено.
   */
  qtyRepair: QtyRepairTrace | null;
};

export async function recognizePhotoUpd(args: {
  buffer: Buffer;
  mimeType: string;
  /** Метка для журнала llm_calls: без неё вызов пишется как `no-name`. */
  label: string;
  /**
   * Разрешено ли ПРИМЕНЯТЬ восстановление количества (режим `on`).
   *
   * Решает вызывающий, а не этот модуль: условия у фото свои — приёмка не
   * подтверждена, распознавание первичное, следа применённой правки ещё нет.
   * Проверять их надо там, где есть доступ к записи и транзакция.
   */
  allowQtyRepairApply?: boolean;
}): Promise<PhotoUpdRecognition> {
  const result = await parseUpdVision(
    { buffer: args.buffer, mimeType: args.mimeType, filename: args.label },
    { sourceDocumentId: null },
  );

  // Порядок шагов повторяет worker.ts и менять его нельзя: обе нормализации
  // правят те самые числа, которые потом сверяются.
  let parsed: UpdPdfParsed = normalizeUpdNoPricingTotals(
    result.parsed,
    loadEnv().UPD_NO_PRICING_V1,
  );
  // Сравнение ссылок: функция возвращает тот же объект, когда налог не
  // переписывала. После нашего пересчёта сходимость построчного НДС
  // подтверждает наш расчёт, а не чтение с документа, — qty-repair обязан это
  // знать.
  const beforeVatNormalize = parsed;
  parsed = normalizeLineVatAgainstHeader(parsed);
  const lineVatRewritten = parsed !== beforeVatNormalize;

  // Восстановление количества: наблюдение при любом режиме, кроме off.
  // Применение у фото своё — здесь нет ни dispatch_generation, ни
  // operationTrace: правило разрешено только при первичном распознавании и
  // только вызывающим, который передал allowApply (роут проверяет, что
  // приёмка не подтверждена и следа правки ещё нет).
  const qtyRepairMode = loadEnv().UPD_QTY_REPAIR;
  let qtyRepairTrace: QtyRepairTrace | null = null;
  if (qtyRepairMode !== 'off') {
    const candidates = detectQtyRepairs(parsed, { lineVatRewritten });
    let appliedRows = new Set<number>();
    if (qtyRepairMode === 'on' && args.allowQtyRepairApply === true) {
      const repaired = applyQtyRepairs(parsed, candidates);
      parsed = repaired.parsed;
      appliedRows = new Set(repaired.applied.map((c) => c.row));
    }
    qtyRepairTrace = buildQtyRepairTrace({
      mode: qtyRepairMode,
      candidates,
      appliedRows,
      // У фото-кэша поколения разбора нет; версия результата — updated_at
      // записи, его проставляет роут при сохранении.
      generation: null,
      docVersion: null,
    });
  }

  let validation = validateUpdTotals(toValidatorInput(parsed), {
    detectRecognitionWarnings: true,
  });

  // Итог не пропечатался — считаем по строкам и ПЕРЕСНИМАЕМ сверку. Без
  // пересъёмки в карточке осталось бы расхождение, посчитанное по пустой сумме.
  if (parsed.totalSum == null) {
    const synthesized = synthesizeTotalSum(parsed.items);
    if (synthesized != null) {
      parsed = { ...parsed, totalSum: synthesized };
      validation = validateUpdTotals(toValidatorInput(parsed), {
        detectRecognitionWarnings: true,
      });
    }
  }

  return {
    items: parsed.items.map((item) => ({
      nameRaw: item.nameRaw,
      qty: item.qty ?? null,
      unit: item.unit ?? null,
      // Артикула УПД-промпт не извлекает: поле есть только у терпимого промпта
      // накладных. Выдумывать его нечем.
      invNumber: null,
      price: item.price ?? null,
      sum: item.sum ?? null,
      rowNo: item.rowNo ?? null,
      vatRate: item.vatRate ?? null,
      vatSum: item.vatSum ?? null,
    })),
    docNumber: parsed.docNumber ?? null,
    docDate: parsed.docDate ?? null,
    totalSum: parsed.totalSum ?? null,
    vatSum: parsed.vatSum ?? null,
    itemsCount: parsed.itemsCount ?? null,
    confidence: parsed.confidence,
    model: await modelNameOf(result.llmProviderId),
    validation,
    qtyRepair: qtyRepairTrace,
  };
}

/** Вход валидатора — те же поля и в том же виде, что собирает воркер. */
function toValidatorInput(parsed: UpdPdfParsed): Parameters<typeof validateUpdTotals>[0] {
  return {
    totalSum: parsed.totalSum ?? null,
    vatSum: parsed.vatSum ?? null,
    itemsCount: parsed.itemsCount ?? null,
    items: parsed.items.map((i) => ({
      rowNo: i.rowNo ?? null,
      qty: i.qty ?? null,
      price: i.price ?? null,
      sum: i.sum ?? null,
      unit: i.unit ?? null,
      vatRate: i.vatRate ?? null,
      vatSum: i.vatSum ?? null,
    })),
    // Стороны и сырая графа 4 — для проверки «грузополучатель повторяет
    // покупателя, а бланк этого не подтверждает». Передаём, хотя карточка фото
    // сторон не показывает: сверка обязана быть той же, что на основном пути,
    // иначе один и тот же документ получал бы разные предупреждения в
    // зависимости от того, откуда на него посмотрели.
    recipient: parsed.recipient ?? null,
    consignee: parsed.consignee ?? null,
    consigneeRaw: parsed.consigneeRaw ?? null,
  };
}

/**
 * Имя модели по идентификатору провайдера — для показа в карточке.
 * `parseUpdVision` возвращает только id провайдера, а кэш хранит имя модели,
 * как его хранил прежний путь. Ошибка чтения не должна ронять уже полученный
 * разбор, поэтому null вместо исключения.
 */
async function modelNameOf(providerId: string | null): Promise<string | null> {
  if (!providerId) return null;
  try {
    const [row] = await db
      .select({ model: llmProviders.model })
      .from(llmProviders)
      .where(eq(llmProviders.id, providerId))
      .limit(1);
    return row?.model ?? null;
  } catch {
    return null;
  }
}
