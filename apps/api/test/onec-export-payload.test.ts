/**
 * Сборка данных приёмки для 1С: группы «приёмка + документ», деньги строк,
 * итоги без подмены отсутствующего нулём, получатель/признак/договор документа.
 */
import { describe, expect, it } from 'vitest';
import { buildDeliveryBody, buildLine, buildTotals } from '../src/domain/onec/export-payload.js';
import { DELIVERY_ID, DOC_LINKED, DOC_MENTIONED, fullBundle, item } from './helpers/onec-fixture.js';

const okei = new Map([['т', '168']]);

describe('buildLine', () => {
  it('суммы от qtyActual: без НДС, НДС как хранится, с НДС; цена с НДС до 4 знаков', () => {
    const line = buildLine(item(), okei);
    expect(line).toMatchObject({
      qty: '1.5000',
      sumExVat: '97500.00',
      vatSum: '19500.00',
      sumWithVat: '117000.00',
      priceWithVat: '78000.0000',
      vatRateKind: 'percent',
      okei: '168',
      warnings: [],
    });
  });

  it('нет qtyActual — считаем от qtyPlanned', () => {
    expect(buildLine(item({ qtyActual: null }), okei).sumExVat).toBe('130000.00');
  });

  it('ставка 0: НДС 0.00, цена с НДС = цене', () => {
    const line = buildLine(item({ vatRate: '0.00', vatSum: null }), okei);
    expect(line).toMatchObject({
      vatRateKind: 'zero_or_exempt',
      vatSum: '0.00',
      sumWithVat: '97500.00',
      priceWithVat: '65000.0000',
    });
  });

  it('ставка неизвестна: ни цены с НДС, ни суммы с НДС не выдумываем', () => {
    const line = buildLine(item({ vatRate: null, vatSum: null }), okei);
    expect(line).toMatchObject({
      vatRateKind: 'unknown',
      priceWithVat: null,
      vatSum: null,
      sumWithVat: null,
      sumExVat: '97500.00',
    });
    expect(line.warnings).toEqual(['no_vat_rate', 'no_vat_sum']);
  });

  it('НДС из документа не по ставке — предупреждение, значение не меняется', () => {
    const line = buildLine(item({ vatSum: '9750.00' }), okei);
    expect(line.vatSum).toBe('9750.00');
    expect(line.warnings).toContain('vat_mismatch');
  });

  it('нет цены и количества — предупреждения, сумм нет', () => {
    const line = buildLine(item({ price: null, qtyActual: null, qtyPlanned: null }), okei);
    expect(line.sumExVat).toBeNull();
    expect(line.warnings).toEqual(expect.arrayContaining(['no_qty', 'no_price']));
  });
});

describe('buildTotals', () => {
  it('отсутствующее нулём не считается: учтено N из M', () => {
    const lines = [
      buildLine(item(), okei),
      buildLine(item({ price: null }), okei),
      buildLine(item({ vatRate: null, vatSum: null }), okei),
    ];
    expect(buildTotals(lines)).toEqual({
      linesTotal: 3,
      linesWithSum: 2,
      linesWithVat: 2,
      linesComplete: 1,
      sumExVat: '195000.00',
      vatSum: '39000.00',
      sumWithVat: '117000.00',
      complete: false,
    });
  });

  it('пустая группа: итогов нет, а не нули', () => {
    expect(buildTotals([])).toMatchObject({ linesTotal: 0, sumExVat: null, complete: false });
  });
});

describe('buildDeliveryBody', () => {
  const body = buildDeliveryBody(fullBundle(), '2026-11-11T10:00:00.000000Z');

  it('группа на документ, пустой документ не пропадает, строки без документа — nodoc', () => {
    expect(body.groups.map((g) => g.groupKey)).toEqual([
      `doc:${DOC_LINKED}`,
      `doc:${DOC_MENTIONED}`,
      'nodoc',
    ]);
    expect(body.groups[1]!.lines).toEqual([]);
    expect(body.groups[2]!.document).toBeNull();
    expect(body.groups[2]!.lines.map((l) => l.name)).toEqual(['Без документа']);
  });

  it('свой получатель и признак документа; отвязанный документ наследует общие', () => {
    const [linked, mentioned] = body.groups;
    expect(linked!.document).toMatchObject({
      linked: true,
      recipient: { kind: 'contractor', inn: '7700000002' },
      purpose: 'realization',
    });
    expect(mentioned!.document).toMatchObject({
      linked: false,
      recipient: { kind: 'contractor', inn: '7700000001' },
      purpose: 'own_forces',
    });
  });

  it('договор документа — свой, иначе общий', () => {
    expect(body.groups[0]!.document!.contract!.number).toBe('Лот33');
    expect(body.groups[1]!.document!.contract!.number).toBe('СУ-ЗИЛ/25-40');
    expect(body.contract!.number).toBe('СУ-ЗИЛ/25-40');
  });

  it('ЭДО: с блоком — в документе, без блока — в шапке; путь XML на эту приёмку', () => {
    expect(body.groups[0]!.document!.edo.map((e) => e.number)).toEqual(['УТ-4308']);
    expect(body.edo.map((e) => e.number)).toEqual(['57/50126']);
    expect(body.edo[0]!.xmlPath).toBe(
      `/api/v1/integration/1c/deliveries/${DELIVERY_ID}/edo/d0000000-0000-4000-8000-000000000002/xml`,
    );
  });

  it('общая УПД: соседи без самой приёмки; возможные дубли', () => {
    expect(body.groups[0]!.document!.sharedWith).toEqual([
      { id: '44444444-4444-4444-8444-444444444444', displayId: 24510 },
    ]);
    expect(body.groups[0]!.document!.portalDuplicates).toEqual(['55555555-5555-4555-8555-555555555555']);
    expect(body.groups[0]!.document!.dedupKey).toEqual({
      supplierInn: '5000000001',
      number: 'УТ-4308',
      date: '2026-11-10',
    });
  });

  it('перемещение помечено, удаление видно', () => {
    expect(body.operation).toBe('transfer');
    expect(body.deletion).toEqual({ pendingSince: '2026-11-12T07:00:00.000000Z' });
  });
});
