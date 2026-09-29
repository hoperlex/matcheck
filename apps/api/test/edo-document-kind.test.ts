/**
 * Отбор документов ящика: какие — УПД с материалами, а какие нет.
 *
 * В ящике лежит всё подряд — счета, акты, договоры, УПД на работы и услуги.
 * В портал должны попадать только УПД, по которым приехали материалы. Каждая
 * ветка решения проверяется отдельно: ошибка в любой из них либо тянет в
 * портал чужие документы, либо молча теряет нужные.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDocumentMeta,
  classifyUtdContent,
  type EdoMetaInput,
} from '../src/domain/edo/document-kind.js';
import { parseUpdXml, type UpdParsed } from '../src/domain/edo/upd.parser.js';

const clean: EdoMetaInput = {
  typeNamedId: 'UniversalTransferDocument',
  documentFunction: 'СЧФДОП',
  isTest: false,
  revoked: false,
  isDeleted: false,
  outbound: false,
  encrypted: false,
};

describe('уровень 1: по метаданным, без скачивания', () => {
  it.each([
    [{ documentFunction: 'СЧФДОП' }, 'utd_candidate'],
    [{ documentFunction: 'ДОП' }, 'utd_candidate'],
    // Функция не сообщена — решит XML, а не догадка.
    [{ documentFunction: null }, 'utd_candidate'],
    [{ documentFunction: 'СЧФ' }, 'utd_invoice_only'],
    [{ typeNamedId: 'Invoice', documentFunction: 'default' }, 'invoice'],
    [{ typeNamedId: 'UniversalTransferDocumentRevision' }, 'revision'],
    [{ typeNamedId: 'UniversalCorrectionDocument', documentFunction: 'КСЧФДИС' }, 'correction'],
    [{ typeNamedId: 'XmlTorg12' }, 'waybill'],
    [{ typeNamedId: 'ProformaInvoice' }, 'not_delivery'],
    [{ typeNamedId: 'AcceptanceCertificate' }, 'not_delivery'],
    [{ typeNamedId: 'Contract' }, 'not_delivery'],
    [{ typeNamedId: 'Nonformalized' }, 'scan'],
    [{ typeNamedId: null }, 'scan'],
  ] as const)('%o → %s', (patch, category) => {
    expect(classifyDocumentMeta({ ...clean, ...patch }).category).toBe(category);
  });

  it.each([
    ['isTest', 'тестовый документ'],
    ['revoked', 'документ аннулирован'],
    ['isDeleted', 'документ удалён'],
    ['outbound', 'исходящий документ'],
    ['encrypted', 'содержимое зашифровано'],
  ] as const)('%s исключает документ при любом типе', (flag, reason) => {
    expect(classifyDocumentMeta({ ...clean, [flag]: true })).toEqual({
      category: 'excluded',
      reason,
    });
  });

  it('у каждого решения есть причина', () => {
    expect(classifyDocumentMeta({ ...clean, typeNamedId: 'Letter' }).reason).toBe(
      'не поставка (Letter)',
    );
  });
});

/** Документ с позициями заданного предмета и единиц. */
function utd(items: { kind?: number; unit?: string; name?: string }[], extra = ''): UpdParsed {
  const rows = items
    .map(
      (it, i) => `<СведТов НомСтр="${i + 1}" НаимТов="${it.name ?? `Позиция ${i + 1}`}" НаимЕдИзм="${it.unit ?? 'шт'}"
        КолТов="1" ЦенаТов="100" СтТовБезНДС="100" НалСт="20%" СтТовУчНал="120">
        <СумНал><СумНал>20</СумНал></СумНал>
        ${it.kind ? `<ДопСведТов ПрТовРаб="${it.kind}"/>` : ''}
      </СведТов>`,
    )
    .join('');
  return parseUpdXml(`<Файл><Документ Функция="СЧФДОП">
    <СвСчФакт НомерДок="1" ДатаДок="01.09.2026">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО" ИННЮЛ="7712345678"/></ИдСв></СвПрод>
      ${extra}
    </СвСчФакт>
    <ТаблСчФакт>${rows}</ТаблСчФакт>
  </Документ></Файл>`);
}

describe('уровень 2: по позициям УПД', () => {
  it('хотя бы одна позиция-имущество — материалы, смешанный берётся целиком', () => {
    const decision = classifyUtdContent(utd([{ kind: 1 }, { kind: 3, name: 'Доставка' }]));
    expect(decision.category).toBe('materials');
    expect(decision.kinds).toMatchObject({ goods: 1, service: 1 });
    expect(decision.reason).toContain('1 из 2');
  });

  it('все позиции — работы и услуги: не берём', () => {
    // Случай ИП Железнова: работы с монтажом, в портале их быть не должно.
    const decision = classifyUtdContent(utd([{ kind: 2 }, { kind: 3 }]));
    expect(decision.category).toBe('services');
  });

  it('признак не заполнен, единицы — тонны и кубометры: материалы', () => {
    const decision = classifyUtdContent(utd([{ unit: 'т' }, { unit: 'м3' }]));
    expect(decision.category).toBe('materials');
    expect(decision.reason).toContain('ПрТовРаб не заполнен');
  });

  it('признак не заполнен, есть грузополучатель: материалы', () => {
    const decision = classifyUtdContent(
      utd(
        [{ unit: 'шт' }],
        '<ГрузПолуч><ИдСв><СвЮЛУч НаимОрг="СУ-10" ИННЮЛ="7736255508"/></ИдСв></ГрузПолуч>',
      ),
    );
    expect(decision.category).toBe('materials');
  });

  it('признак не заполнен, единицы услуг: работы или услуги', () => {
    expect(classifyUtdContent(utd([{ unit: 'усл. ед' }, { unit: 'маш.-ч' }])).category).toBe(
      'services',
    );
  });

  it('признаков нет или они спорят — честное «не определено»', () => {
    expect(classifyUtdContent(utd([{ unit: 'шт' }])).category).toBe('undetermined');
    // Товарные единицы и услуги с ПрТовРаб=3 без товарных позиций.
    const mixed = classifyUtdContent(utd([{ kind: 3 }, { unit: 'т' }]));
    expect(mixed.category).toBe('undetermined');
    expect(mixed.reason).toContain('признаки противоречат');
  });

  it('функция СЧФ в самом XML — только счёт-фактура', () => {
    const parsed = { ...utd([{ kind: 1 }]), function: 'СЧФ' };
    expect(classifyUtdContent(parsed).category).toBe('invoice_only');
  });
});
