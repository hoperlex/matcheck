/**
 * Признаки «та же УПД» для строк реестра выгрузки (edo_export_documents).
 *
 * Одна УПД может прийти и через Диадок, и через СБИС. Шаг 0 этапа Р2 (22.10.2026,
 * 30 пар за 05.10–21.10) показал три случая:
 *   - 25 пар — тот же файл байт в байт (совпадает content_sha256);
 *   - 3 пары — та же УПД, отправленная повторно новым файлом: номер, дата,
 *     продавец, суммы и позиции те же, а файл и его ИдФайл другие;
 *   - 2 пары — разные документы «Службы Механизации» с одним номером и датой
 *     (другой НДС, другие позиции). Склейка по реквизитам шапки — ошибка.
 * Поэтому признаков три, и каждый из них не склеивает разные УПД: тот же файл,
 * тот же ИдФайл, тот же состав (`contentKeyOf`) — включая каждую позицию.
 *
 * `contentKeyOf` — единственная функция отпечатка: её вызывает и запись реестра,
 * и разовый пересчёт старых строк (scripts/edo-identity-backfill.ts). Две версии
 * разошлись бы, и копии перестали бы находиться.
 */
import { createHash } from 'node:crypto';
import { normalizeDocumentNumber } from '../operations/edo-match.js';
import type { UpdParsed } from './upd.parser.js';

/** Версия правила отпечатка: смена правила — новый префикс, старые ключи не совпадут. */
const CONTENT_KEY_VERSION = 1;

const digits = (value: string | null | undefined): string | null => {
  const d = (value ?? '').replace(/\D/g, '');
  return d || null;
};

/** Название позиции без различий в регистре, пробелах и «ё». */
function normName(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** Число в каноничной десятичной записи: 2, 2.5, 0.125 — без хвостовых нулей и экспоненты. */
function canonNumber(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  // 6 знаков после запятой — больше в УПД не бывает (количество до 0,000001).
  const fixed = value.toFixed(6).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

/** Сумма в копейках: в реестре и печатной форме суммы — до копейки. */
function kopecks(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function isoDate(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  return ru ? `${ru[3]}-${ru[2]}-${ru[1]}` : null;
}

/**
 * Отпечаток состава УПД: продавец, покупатель, номер, дата, функция,
 * исправление, итоги и все позиции по порядку. Нет номера, даты или ни одной
 * позиции — `null`: по такому составу копии не опознаются.
 */
export function contentKeyOf(parsed: UpdParsed): string | null {
  const number = normalizeDocumentNumber(parsed.docNumber);
  const date = isoDate(parsed.docDate);
  if (!number || !date || parsed.items.length === 0) return null;
  const canonical = {
    v: CONTENT_KEY_VERSION,
    seller: digits(parsed.supplier.inn),
    buyerInn: digits(parsed.recipient?.inn),
    buyerKpp: digits(parsed.recipient?.kpp),
    number,
    date,
    function: parsed.function?.trim().toUpperCase() || null,
    correction: parsed.correction
      ? { number: parsed.correction.number?.trim() || null, date: isoDate(parsed.correction.date) }
      : null,
    total: kopecks(parsed.totalSum),
    totalExVat: kopecks(parsed.totalExVat),
    vat: kopecks(parsed.vatSum),
    items: [...parsed.items]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((i) => [
        normName(i.nameRaw),
        canonNumber(i.qty),
        i.unitCode?.trim() || normName(i.unit) || null,
        canonNumber(i.price),
        kopecks(i.sum),
        kopecks(i.sumExVat),
        kopecks(i.vatSum),
      ]),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** ИдФайл из XML — у копии того же файла, пришедшей другим путём, он тот же. */
export function fileIdOf(parsed: UpdParsed): string | null {
  return parsed.fileId?.trim() || null;
}
