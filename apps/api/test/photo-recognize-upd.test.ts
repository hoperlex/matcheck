/**
 * Адаптер УПД-разбора для фото документа.
 *
 * Проверяется не распознавание, а ЦЕПОЧКА: воркер после parseUpdVision
 * применяет две нормализации и только потом сверяет суммы, а при недостающем
 * итоге считает его по строкам и пересверяет заново. Роут, зовущий парсер
 * напрямую, всё это обходил бы — и обещание «исправления основного пути
 * работают и для фото» было бы неправдой.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';

const parseUpdVision = vi.fn();

vi.mock('../src/db/client.js', () => ({ db: {} }));
vi.mock('../src/domain/edo/upd-vision.parser.js', () => ({ parseUpdVision }));
// Имя модели читается из БД отдельным запросом; здесь он не нужен.
vi.mock('../src/db/schema.js', () => ({ llmProviders: {} }));

const { recognizePhotoUpd } = await import('../src/domain/photos/recognize-upd.js');

function parsed(over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  return {
    docNumber: '2788',
    docDate: '2026-08-31',
    totalSum: 93375,
    vatSum: 16838.11,
    pricing: 'printed',
    itemsCount: null,
    supplier: null,
    recipient: null,
    consignee: null,
    consigneeRaw: null,
    items: [
      {
        nameRaw: 'Пена монтажная Империал 65 UNIVERSAL',
        rowNo: 1,
        qty: 249,
        unit: 'шт',
        price: 307.38,
        sum: 93375,
        vatRate: 22,
        vatSum: 16838.11,
        volumeM3: null,
        massKg: null,
        volumeConfidence: null,
        groupName: null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
    confidence: 0.95,
    ...over,
  } as UpdPdfParsed;
}

beforeEach(() => {
  parseUpdVision.mockReset();
});

describe('recognizePhotoUpd', () => {
  it('отдаёт позиции с НДС и номером строки, а сверку — целиком', async () => {
    parseUpdVision.mockResolvedValue({ parsed: parsed(), textLength: 0, llmProviderId: null });

    const r = await recognizePhotoUpd({
      buffer: Buffer.from('x'),
      mimeType: 'image/jpeg',
      label: 'photo:1',
    });

    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      qty: 249,
      price: 307.38,
      sum: 93375,
      vatSum: 16838.11,
      rowNo: 1,
    });
    expect(r.totalSum).toBe(93375);
    expect(r.vatSum).toBe(16838.11);
    // Обе группы, а не только warnings: расхождение строки с итогом живёт в checks.
    expect(r.validation.checks.length).toBeGreaterThan(0);
    expect(r.validation.hasMismatch).toBe(false);
  });

  it('метка вызова доезжает до журнала как filename', async () => {
    parseUpdVision.mockResolvedValue({ parsed: parsed(), textLength: 0, llmProviderId: null });

    await recognizePhotoUpd({
      buffer: Buffer.from('x'),
      mimeType: 'image/jpeg',
      label: 'photo:abc',
    });

    expect(parseUpdVision).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'photo:abc' }),
      expect.anything(),
    );
  });

  it('код ОКЕИ в количестве помечается предупреждением', async () => {
    // Тот самый боевой случай: 796 — код «шт» из графы 2, а не количество.
    parseUpdVision.mockResolvedValue({
      parsed: parsed({
        totalSum: 94537.74,
        vatSum: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        items: [
          {
            nameRaw: 'Пена монтажная Империал 65 UNIVERSAL',
            rowNo: 1,
            qty: 796,
            unit: 'шт',
            price: 118.766,
            sum: 94537.74,
            vatRate: null,
            vatSum: null,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
      }),
      textLength: 0,
      llmProviderId: null,
    });

    const r = await recognizePhotoUpd({
      buffer: Buffer.from('x'),
      mimeType: 'image/jpeg',
      label: 'photo:2',
    });

    expect(r.validation.warnings?.map((w) => w.name)).toContain('unit_code_as_qty');
  });

  it('итог считается по строкам, когда он не пропечатался, и сверка пересчитывается', async () => {
    parseUpdVision.mockResolvedValue({
      parsed: parsed({ totalSum: null, vatSum: null }),
      textLength: 0,
      llmProviderId: null,
    });

    const r = await recognizePhotoUpd({
      buffer: Buffer.from('x'),
      mimeType: 'image/jpeg',
      label: 'photo:3',
    });

    expect(r.totalSum).toBe(93375);
    // Сверка снята уже по синтезированному итогу: расхождения «пусто против
    // 93 375» в карточке быть не должно.
    const sumTotal = r.validation.checks.find((c) => c.name === 'sum_total');
    expect(sumTotal?.expected).toBe(93375);
    expect(sumTotal?.ok).toBe(true);
  });

  it('построчный НДС, противоречащий шапке, приводится к ней до сверки', async () => {
    // Нормализация из основного пути: модель выставила привычные 20 % там, где
    // документ считает по 22 %. Без неё строка уехала бы в расхождение.
    parseUpdVision.mockResolvedValue({
      parsed: parsed({
        totalSum: 1220,
        vatSum: 220,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        items: [
          {
            nameRaw: 'Товар',
            rowNo: 1,
            qty: 1,
            unit: 'шт',
            price: 1000,
            sum: 1220,
            vatRate: 20,
            vatSum: 203.33,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
      }),
      textLength: 0,
      llmProviderId: null,
    });

    const r = await recognizePhotoUpd({
      buffer: Buffer.from('x'),
      mimeType: 'image/jpeg',
      label: 'photo:4',
    });

    expect(r.items[0]?.vatRate).toBe(22);
    expect(r.validation.checks.find((c) => c.name === 'vat_total')?.ok).toBe(true);
  });
});
