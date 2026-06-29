// Multi-UPD bundle на ТЕКСТОВОМ пути (несколько счёт-фактур в одном PDF с
// текстовым слоем — электронные УПД из ЭДО). Симметрично vision-bundle
// (upd-bundle.parser.ts), но сегментирует по тексту pdf-parse, а не по
// PNG-страницам — дешевле и детерминированнее. Переиспользует
// aggregateUpdDocuments (Шаг 1) и extractUpdFromText (text-LLM из
// upd-pdf.parser.ts).
//
// Безопасность: вызывается ДО обычного parseUpdPdf и при любом сомнении
// (уникальных номеров < 2 / сегментов < 2 / извлеклось < 2 / нет текста /
// слишком большая пачка) возвращает null — тогда worker идёт обычным
// одиночным путём БЕЗ изменений. Одиночные УПД (один уникальный номер, в т.ч.
// напечатанный в 2 экземпляра — как 1221312) не трогаются.

import { PDFParse } from 'pdf-parse';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { extractUpdFromText } from './upd-pdf.parser.js';
import { aggregateUpdDocuments, type ParsedUpdSubdocument } from './upd-batch.parser.js';
import type { UpdBundleResult } from './upd-bundle.parser.js';

// Якоря номера УПД в тексте pdf-parse (берём первый сработавший на странице):
//  - главная страница: «СЧЕТ-ФАКТУРА № <N> от <дата>»
//  - дубль-якорь: «Универсальный передаточный документ, № <N> от <дата>»
// ВАЖНО: \w в JS НЕ матчит кириллицу — слова пишем явными буквами.
const SF_ANCHOR = /сч[её]т-фактура\s*№\s*(\S+?)\s+от\s+([\d./]+)/i;
const DOC_ANCHOR = /универсальный\s+передаточный\s+документ,?\s*№\s*(\S+?)\s+от\s+([\d./]+)/i;

// Верхний предел субдокументов: защита от десятков LLM-вызовов на гигантских
// пачках. Алия=15 — с запасом. Сверх лимита → null (обычный одиночный путь).
const MAX_TEXT_BUNDLE_SUBDOCS = 40;

export type TextUpdSegment = {
  segmentIndex: number;
  docNumber: string;
  docDate: string | null;
  pages: number[];
  text: string;
};

type PdfPage = { num: number; text: string };

// Номер (и дата) счёт-фактуры со страницы, либо null если страница —
// продолжение таблицы (без заголовка счёт-фактуры/УПД).
function pageInvoice(text: string): { number: string; date: string | null } | null {
  const t = text.replace(/\s+/g, ' ');
  const m = SF_ANCHOR.exec(t) ?? DOC_ANCHOR.exec(t);
  if (!m || !m[1]) return null;
  return { number: m[1], date: m[2] ?? null };
}

/**
 * Дешёвый precheck: сколько РАЗНЫХ номеров счёт-фактур в постраничном тексте.
 * Считаем уникальные номера, а НЕ вхождения «СЧЕТ-ФАКТУРА»: один УПД часто
 * печатается в 2 экземпляра (1221312 — 2 заголовка, но 1 уникальный номер →
 * это НЕ пакет, обычный одиночный путь).
 */
export function countUniqueUpdInvoices(pages: PdfPage[]): number {
  const nums = new Set<string>();
  for (const p of pages) {
    const inv = pageInvoice(p.text);
    if (inv) nums.add(inv.number);
  }
  return nums.size;
}

/**
 * Режет постраничный текст на блоки «один блок = один УПД» по переходам номера
 * счёт-фактуры. Страница без номера — продолжение текущего блока. Копии того
 * же номера (смежные или повторяющиеся позже) сливаются в один блок (merge by
 * number), чтобы каждый уникальный УПД извлекался ровно один раз.
 */
export function segmentUpdText(pages: PdfPage[]): TextUpdSegment[] {
  const byNumber = new Map<string, TextUpdSegment>();
  const order: string[] = [];
  let current: TextUpdSegment | null = null;

  for (const p of pages) {
    const inv = pageInvoice(p.text);
    if (inv) {
      let seg = byNumber.get(inv.number);
      if (!seg) {
        seg = {
          segmentIndex: order.length,
          docNumber: inv.number,
          docDate: inv.date,
          pages: [],
          text: '',
        };
        byNumber.set(inv.number, seg);
        order.push(inv.number);
      }
      current = seg;
    }
    if (current) {
      current.pages.push(p.num);
      current.text += (current.text ? '\n' : '') + p.text;
    }
    // Страница без номера и без текущего сегмента (мусор до первого УПД) —
    // молча пропускаем: она не относится ни к одному УПД.
  }

  return order.map((n) => byNumber.get(n)!);
}

/**
 * Пытается распознать текстовый PDF как пакет из НЕСКОЛЬКИХ УПД и вернуть
 * агрегат (docNumber «N1, N2, …», объединённые позиции). Возвращает null,
 * если это НЕ пакет — тогда worker идёт обычным одиночным parseUpdPdf без
 * изменений.
 */
export async function tryParseTextUpdBundle(
  buffer: Buffer,
  ctx: { sourceDocumentId: string | null },
): Promise<UpdBundleResult | null> {
  // ── извлечение постраничного текста (один вызов pdf-parse) ──
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let pages: PdfPage[] = [];
  try {
    const result = await parser.getText();
    pages = (result.pages ?? []).map((p) => ({
      num: typeof p.num === 'number' ? p.num : 0,
      text: p.text ?? '',
    }));
  } catch {
    // Битый/без текста PDF — пусть обычный путь решает (parseUpdPdf сам
    // бросит PdfNoTextError/PdfTextGarbageError и уйдёт в vision-fallback).
    return null;
  } finally {
    await parser.destroy().catch(() => undefined);
  }

  // ── дешёвый гейт: пакет = ≥ 2 РАЗНЫХ номера счёт-фактур ──
  if (countUniqueUpdInvoices(pages) < 2) return null;

  const segments = segmentUpdText(pages);
  if (segments.length < 2) return null;
  if (segments.length > MAX_TEXT_BUNDLE_SUBDOCS) return null;

  // ── извлечение каждого УПД по своему текстовому блоку (text-LLM) ──
  const subdocs: ParsedUpdSubdocument[] = [];
  let llmProviderId: string | null = null;
  for (const seg of segments) {
    try {
      const { parsed, llmProviderId: pid } = await extractUpdFromText(seg.text, ctx);
      if (pid) llmProviderId = pid;
      subdocs.push({ ...parsed, pages: seg.pages, segmentIndex: seg.segmentIndex });
    } catch {
      // Ошибка одного блока — пропускаем, агрегируем остальные (как vision-bundle).
    }
  }

  // Меньше двух реально извлечённых УПД — не считаем надёжным bundle.
  if (subdocs.length < 2) return null;

  const agg = aggregateUpdDocuments(subdocs);
  const parsed: UpdPdfParsed = {
    docNumber: agg.docNumber,
    docDate: agg.docDate,
    totalSum: agg.totalSum,
    vatSum: agg.vatSum,
    itemsCount: agg.itemsCount,
    supplier: agg.supplier,
    recipient: agg.recipient,
    items: agg.items,
    confidence: agg.confidence,
  };

  return {
    parsed,
    llmProviderId: llmProviderId ?? '',
    segments: segments.length,
    extracted: subdocs.length,
    subdocs: agg.subdocs,
    reasons: agg.reasons,
  };
}
