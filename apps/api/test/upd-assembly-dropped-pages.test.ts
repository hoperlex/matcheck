/**
 * Выброшенные страницы перестают исчезать бесследно.
 *
 * Страницы, уверенно опознанные как накладная или сертификат, в сегменты УПД
 * не идут — и до сих пор об этом нигде не оставалось записи. Асимметрия была
 * прямо в коде: для страниц, которые классификатор не упомянул, причина
 * писалась, а для выброшенных — нет. На бою из-за этого смешанный пакет молча
 * терял накладную: файл оставался вложением УПД, документа по нему не было,
 * а строка реестра сообщала «создано».
 */
import { describe, expect, it } from 'vitest';
import { planUpdSegments } from '../src/domain/edo/upd-assembly.js';
import type { PageClassification } from '../src/domain/edo/upd-page-prefilter.js';

const page = (n: number, type: PageClassification['type']): PageClassification => ({
  page: n,
  type,
  use: type !== 'certificate' && type !== 'transport_waybill',
});

describe('исключённые страницы в плане', () => {
  it('накладная внутри УПД-пакета попадает в droppedPages и в reasons', () => {
    const plan = planUpdSegments(
      [page(1, 'upd_main'), page(2, 'transport_waybill'), page(3, 'upd_main')],
      3,
      5,
    );
    expect(plan.droppedPages).toEqual([{ page: 2, type: 'transport_waybill' }]);
    expect(plan.reasons.join('; ')).toContain('исключены как чужие: 2 (transport_waybill)');
    // Сама нарезка не меняется: две УПД как были, так и остались.
    expect(plan.segments.map((s) => s.pages)).toEqual([[1], [3]]);
    expect(plan.confident).toBe(true);
  });

  it('сертификаты тоже перечисляются', () => {
    const plan = planUpdSegments([page(1, 'upd_main'), page(2, 'certificate')], 2, 5);
    expect(plan.droppedPages).toEqual([{ page: 2, type: 'certificate' }]);
  });

  it('в чисто-УПД пакете список пуст и лишней причины нет', () => {
    const plan = planUpdSegments([page(1, 'upd_main'), page(2, 'upd_continuation')], 2, 5);
    expect(plan.droppedPages).toEqual([]);
    expect(plan.reasons.join('; ')).not.toContain('исключены как чужие');
  });

  it('пакет вообще без УПД-страниц: список сохраняется и в отказном плане', () => {
    // Именно этот случай уезжал в УПД-парсер с видом «УПД»: система знала, что
    // перед ней накладная, и всё равно отправляла её не туда.
    const plan = planUpdSegments([page(1, 'transport_waybill')], 1, 5);
    expect(plan.confident).toBe(false);
    expect(plan.droppedPages).toEqual([{ page: 1, type: 'transport_waybill' }]);
  });
});
