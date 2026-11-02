/**
 * Опись и выгрузка договоров на фейковом Диадоке.
 *
 * Закреплены оба шлюза: неполная опись (окно не сошлось, 400 в контроле по
 * типам, не прочитан состав сообщения — в том числе добавленного по PacketId)
 * не пускает выгрузку; выгрузка без итога по каждому файлу, подписи и PDF —
 * «не завершена», даже если её остановили намеренно (--limit, время).
 */
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiadocPrintFormResult, GetDocumentsParams } from '../src/domain/edo/diadoc.client.js';
import type { DiadocDocumentList, DiadocEntity, DiadocListedDocument, DiadocMessage } from '../src/domain/edo/diadoc.types.js';
import { DiadocGone, DiadocSubscriptionExpired } from '../src/domain/edo/diadoc.http.js';
import { EdoLeaseLost } from '../src/domain/edo/inventory.js';
import { dateToTicks } from '../src/domain/edo/list-windows.js';
import {
  DownloadRefused,
  collectDownloadState,
  recipientStateOf,
  runContractDownload,
} from '../src/domain/edo/contracts/download.js';
import { runContractInventory } from '../src/domain/edo/contracts/inventory.js';
import { writeContractsXlsx } from '../src/domain/edo/contracts/inventory-xlsx.js';
import { isRunnerSkipped } from '../src/domain/jobs/edo-run-skip.js';
import { readProgress, type InventorySnapshot } from '../src/domain/edo/contracts/snapshot.js';

const BOX = 'box-su10';
const SINCE = new Date('2021-11-01T21:00:00Z');
const UNTIL = new Date('2026-11-02T09:00:00Z');

type Doc = DiadocListedDocument & { ticks: bigint };

let seq = 0;
function doc(messageId: string, entityId: string, extra: Partial<DiadocListedDocument> & { day: string }): Doc {
  const ticks = dateToTicks(new Date(`${extra.day}T09:00:00Z`)) + BigInt(seq++);
  const outbound = extra.DocumentDirection === 'Outbound';
  const { day: _day, ...rest } = extra;
  return {
    MessageId: messageId,
    EntityId: entityId,
    IndexKey: `k-${entityId}`,
    TypeNamedId: 'Nonformalized',
    DocumentDirection: 'Inbound',
    ...(outbound ? { SendTimestampTicks: ticks.toString() } : { DeliveryTimestampTicks: ticks.toString() }),
    RecipientResponseStatus: 'WithRecipientSignature',
    RevocationStatus: 'RevocationStatusNone',
    ...rest,
    ticks,
  } as Doc;
}

/** Ящик: договор с пакетом, приложение того же пакета в другом сообщении, спорное, исключённое, ДС, исходящий договор. */
function boxDocs(): Doc[] {
  seq = 0;
  return [
    doc('m1', 'e1', { day: '2023-05-10', FileName: 'Договор поставки 1.pdf', CounteragentBoxId: 'box-a', PacketId: 'p1' }),
    doc('m1', 'e2', { day: '2023-05-10', FileName: 'Счет 15.pdf', CounteragentBoxId: 'box-a', PacketId: 'p1' }),
    doc('m1', 'e3', { day: '2023-05-10', TypeNamedId: 'UniversalTransferDocument', FileName: 'upd.xml', CounteragentBoxId: 'box-a', PacketId: 'p1' }),
    doc('m2', 'e4', { day: '2023-05-11', FileName: 'Приложение 1 к договору 1.pdf', CounteragentBoxId: 'box-a', PacketId: 'p1' }),
    doc('m2', 'e5', { day: '2023-05-11', FileName: 'Письмо.pdf', CounteragentBoxId: 'box-a', PacketId: 'p9' }),
    doc('m3', 'e6', { day: '2024-01-15', FileName: 'Спецификация №2 к договору 1.xlsx', CounteragentBoxId: 'box-a' }),
    doc('m4', 'e7', { day: '2024-02-01', FileName: 'КС-2 по ДС 3.pdf', CounteragentBoxId: 'box-a' }),
    doc('m5', 'e8', { day: '2025-06-01', TypeNamedId: 'SupplementaryAgreement', FileName: 'scan.pdf', CounteragentBoxId: 'box-c' }),
    doc('m6', 'e9', { day: '2026-03-01', DocumentDirection: 'Outbound', FileName: 'Договор подряда СУ-10.docx', CounteragentBoxId: 'box-b', RecipientResponseStatus: 'RecipientSignatureRequestRejected' }),
    doc('m7', 'e10', { day: '2026-04-01', TypeNamedId: 'UniversalTransferDocument', FileName: 'upd2.xml', CounteragentBoxId: 'box-a' }),
  ];
}

const att = (id: string, typeNamedId: string, extra: Partial<DiadocEntity> = {}): DiadocEntity =>
  ({ EntityId: id, EntityType: 'Attachment', DocumentInfo: { TypeNamedId: typeNamedId }, ...extra }) as DiadocEntity;
const sig = (id: string, parent: string, signer: string, extra: Partial<DiadocEntity> = {}): DiadocEntity =>
  ({ EntityId: id, EntityType: 'Signature', ParentEntityId: parent, SignerBoxId: signer, ...extra }) as DiadocEntity;

function boxMessages(): Record<string, DiadocMessage> {
  const inbound = (id: string, entities: DiadocEntity[]): DiadocMessage =>
    ({ MessageId: id, FromBoxId: 'box-a', FromTitle: 'ООО Альфа', ToBoxId: BOX, Entities: entities }) as DiadocMessage;
  return {
    m1: inbound('m1', [
      att('e1', 'Nonformalized', { FileName: 'Договор поставки 1.pdf', NeedRecipientSignature: true, PacketId: 'p1' }),
      sig('s1', 'e1', 'box-a'),
      sig('s2', 'e1', BOX),
      att('e2', 'Nonformalized', { FileName: 'Счет 15.pdf', PacketId: 'p1' }),
      sig('s3', 'e2', 'box-a'),
      att('e3', 'UniversalTransferDocument', { FileName: 'upd.xml', PacketId: 'p1' }),
      sig('s4', 'e3', 'box-a'),
    ]),
    m2: inbound('m2', [
      att('e4', 'Nonformalized', { FileName: 'Приложение 1 к договору 1.pdf', PacketId: 'p1' }),
      sig('s5', 'e4', 'box-a'),
      att('e5', 'Nonformalized', { FileName: 'Письмо.pdf', PacketId: 'p9' }),
    ]),
    m3: inbound('m3', [att('e6', 'Nonformalized', { FileName: 'Спецификация №2 к договору 1.xlsx' }), sig('s6', 'e6', 'box-a')]),
    m4: inbound('m4', [att('e7', 'Nonformalized', { FileName: 'КС-2 по ДС 3.pdf' })]),
    m5: {
      MessageId: 'm5',
      FromBoxId: 'box-c',
      ToBoxId: BOX,
      Entities: [
        att('e8', 'SupplementaryAgreement', { FileName: 'scan.pdf' }),
        sig('s7', 'e8', 'box-c'),
        sig('s8', 'e8', BOX, { IsApprovementSignature: true }),
      ],
    } as DiadocMessage,
    m6: {
      MessageId: 'm6',
      FromBoxId: BOX,
      ToBoxId: 'box-b',
      ToTitle: 'ООО Бета',
      Entities: [
        att('e9', 'Nonformalized', { FileName: 'Договор подряда СУ-10.docx', NeedRecipientSignature: true }),
        sig('s9', 'e9', BOX),
        { EntityId: 'r1', EntityType: 'Attachment', AttachmentType: 'SignatureRequestRejection', ParentEntityId: 'e9' } as DiadocEntity,
      ],
    } as DiadocMessage,
  };
}

type Hooks = {
  failCategory?: string;
  lieTotalFor?: string;
  failMessage?: string;
  leaseLostAfter?: number;
  printForm?: (entityId: string, attempt: number) => DiadocPrintFormResult;
  /** Отказ на скачивании содержимого сущности. */
  contentError?: (entityId: string) => Error | null;
};

function fakeBox(hooks: Hooks = {}) {
  const docs = boxDocs();
  const messages = boxMessages();
  const printAttempts = new Map<string, number>();
  const calls = { getMessage: 0, getEntityContent: 0, generatePrintForm: 0 };
  const client = {
    getMyEmployee: async () => ({ Permissions: { DocumentAccessLevel: 'AllDocuments' } }),
    getDocumentTypes: async () =>
      ['Nonformalized', 'Contract', 'SupplementaryAgreement', 'UniversalTransferDocument'].map((name) => ({
        name,
        title: null,
        versions: [],
      })),
    getDocuments: async (p: GetDocumentsParams): Promise<DiadocDocumentList> => {
      if (hooks.failCategory === p.filterCategory) throw new Error('Diadoc: запрос отклонён (HTTP 400)');
      const [type, cls] = p.filterCategory.split('.') as [string, string];
      const found = docs
        .filter((d) => (type === 'Any' || d.TypeNamedId === type) && d.DocumentDirection === cls)
        .filter((d) => (p.fromTicks == null || d.ticks >= p.fromTicks) && (p.toTicks == null || d.ticks <= p.toTicks))
        .sort((a, b) => (a.ticks < b.ticks ? -1 : 1));
      const start = p.afterIndexKey ? found.findIndex((d) => d.IndexKey === p.afterIndexKey) + 1 : 0;
      const lie = hooks.lieTotalFor === p.filterCategory ? 1 : 0;
      return {
        Documents: found.slice(start, start + (p.count ?? 100)),
        TotalCount: Math.min(found.length, 1000) + lie,
        HasMoreResults: found.length > 1000,
      };
    },
    getMessage: async (_box: string, messageId: string): Promise<DiadocMessage> => {
      calls.getMessage += 1;
      if (hooks.failMessage === messageId) throw new Error('Diadoc: временный сбой');
      const m = messages[messageId];
      if (!m) throw new Error(`нет сообщения ${messageId}`);
      return structuredClone(m);
    },
    getOrganization: async (boxId: string) => {
      if (boxId === 'box-a') return { inn: '7700000001', kpp: '770001001', name: 'ООО Альфа' };
      if (boxId === 'box-b') return null;
      throw new Error('Diadoc: временный сбой');
    },
    getEntityContent: async (_box: string, _m: string, entityId: string) => {
      calls.getEntityContent += 1;
      const err = hooks.contentError?.(entityId);
      if (err) throw err;
      return Buffer.from(entityId.startsWith('s') ? `SIG ${entityId}` : `%PDF-1.4 ${entityId}`);
    },
    generatePrintForm: async (_box: string, _m: string, entityId: string): Promise<DiadocPrintFormResult> => {
      calls.generatePrintForm += 1;
      const attempt = (printAttempts.get(entityId) ?? 0) + 1;
      printAttempts.set(entityId, attempt);
      if (hooks.printForm) return hooks.printForm(entityId, attempt);
      if (entityId === 'e1' && attempt === 1) return { state: 'retry', afterMs: 120_000 };
      if (entityId === 'e2') return { state: 'unavailable', status: 409, text: 'нельзя для счёта' };
      return { state: 'ready', pdf: Buffer.from(`%PDF-1.4 print ${entityId}`) };
    },
  };
  let leaseCalls = 0;
  const session = {
    account: { id: 'acc', name: 'Диадок_СУ10' },
    boxId: BOX,
    client,
    ensureLease: async () => {
      leaseCalls += 1;
      if (hooks.leaseLostAfter !== undefined && leaseCalls > hooks.leaseLostAfter) throw new EdoLeaseLost();
    },
  };
  return { session, messages, calls };
}

let outDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'edo-contracts-'));
});
afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const byEntity = (snap: InventorySnapshot, entityId: string) => snap.rows.find((r) => r.entityId === entityId)!;

async function inventory(hooks: Hooks = {}) {
  const box = fakeBox(hooks);
  const snap = await runContractInventory(box.session, { since: SINCE, until: UNTIL });
  return { box, snap };
}

describe('опись', () => {
  it('полная опись: пакет по сообщению и по PacketId, спорное отдельно, контрагенты по каждому ящику', async () => {
    const { snap } = await inventory();
    expect(snap.reasons).toEqual([]);
    expect(snap.complete).toBe(true);

    expect(byEntity(snap, 'e1')).toMatchObject({ category: 'contract', selection: 'auto', inventorySignatures: 2, needRecipientSignature: true });
    expect(byEntity(snap, 'e2')).toMatchObject({ category: 'package', nameCategory: 'unrecognized', packageVia: 'message' });
    expect(byEntity(snap, 'e3')).toMatchObject({ category: 'package', nameCategory: null, packageVia: 'message' });
    expect(byEntity(snap, 'e4')).toMatchObject({ category: 'package', nameCategory: 'spec', packageVia: 'packet' });
    // Другой пакет в том же сообщении в пакет договора не входит.
    expect(byEntity(snap, 'e5')).toMatchObject({ category: 'unrecognized', selection: 'unrecognized' });
    expect(byEntity(snap, 'e6')).toMatchObject({ category: 'spec', selection: 'review' });
    expect(byEntity(snap, 'e7')).toMatchObject({ category: 'excluded', selection: 'excluded' });
    expect(byEntity(snap, 'e8')).toMatchObject({ category: 'supplementary', selection: 'auto' });
    expect(byEntity(snap, 'e9')).toMatchObject({ category: 'contract', selection: 'auto', direction: 'outbound' });
    // УПД вне пакетов в опись не попадает, но считается.
    expect(snap.rows.find((r) => r.entityId === 'e10')).toBeUndefined();
    expect(snap.counts['2026|inbound|UniversalTransferDocument']).toBe(1);

    expect(snap.messages.map((m) => [m.messageId, m.expandedBy]).sort()).toEqual([
      ['m1', 'anchor'],
      ['m2', 'packet'],
      ['m5', 'anchor'],
      ['m6', 'anchor'],
    ]);
    const cps = new Map(snap.counterparties.map((c) => [c.boxId, c]));
    expect(cps.get('box-a')).toMatchObject({ inn: '7700000001', source: 'organization' });
    expect(cps.get('box-b')).toMatchObject({ inn: null, name: 'ООО Бета', source: 'message' });
    expect(cps.get('box-c')).toMatchObject({ inn: null, source: 'unknown' });
    expect(snap.notes.join(' ')).toContain('реквизиты не получены у 1');

    expect(snap.typeControls.find((c) => c.typeNamedId === 'SupplementaryAgreement' && c.direction === 'Inbound')).toMatchObject({
      state: 'ok',
      expected: 1,
      listed: 1,
    });
    expect(snap.windows.every((w) => w.read === w.total)).toBe(true);
    expect(snap.rows.map((r) => r.row)).toEqual(snap.rows.map((_, i) => i + 1));
  });

  it('окно не сошлось — опись неполная', async () => {
    const { snap } = await inventory({ lieTotalFor: 'Any.Outbound' });
    expect(snap.complete).toBe(false);
    expect(snap.reasons.join(' ')).toContain('прочитано 1 из 2');
  });

  it('400 в контроле по типам — опись неполная, а не «тип недоступен»', async () => {
    const { snap } = await inventory({ failCategory: 'Contract.Outbound' });
    expect(snap.complete).toBe(false);
    expect(snap.typeControls.find((c) => c.typeNamedId === 'Contract' && c.direction === 'Outbound')).toMatchObject({ state: 'error' });
    expect(snap.reasons.join(' ')).toContain('HTTP 400');
  });

  it('не прочитан состав сообщения, добавленного по PacketId, — опись неполная', async () => {
    const { snap } = await inventory({ failMessage: 'm2' });
    expect(snap.complete).toBe(false);
    expect(snap.reasons.join(' ')).toContain('m2');
  });

  it('Диадок не ответил на проверку доступа — опись неполная с причиной, а не падение', async () => {
    const box = fakeBox();
    box.session.client.getMyEmployee = async () => {
      throw new Error('Diadoc: временный сбой');
    };
    const snap = await runContractInventory(box.session, { since: SINCE, until: UNTIL });
    expect(snap.complete).toBe(false);
    expect(snap.reasons.join(' ')).toContain('проверка доступа');
  });

  it('потеря лиза прерывает опись и делает её неполной', async () => {
    const { snap } = await inventory({ leaseLostAfter: 5 });
    expect(snap.complete).toBe(false);
    expect(snap.reasons.join(' ')).toContain('лиз');
  });
});

describe('выгрузка', () => {
  const opts = () => ({ outDir, include: [], addRows: [], maxFileBytes: 1024 * 1024, sleep: async () => {} });

  it('неполная опись и чужой ящик — отказ', async () => {
    const { box, snap } = await inventory({ lieTotalFor: 'Any.Outbound' });
    await expect(runContractDownload(box.session, snap, opts())).rejects.toBeInstanceOf(DownloadRefused);
    const full = (await inventory()).snap;
    await expect(runContractDownload({ ...box.session, boxId: 'other' }, full, opts())).rejects.toBeInstanceOf(DownloadRefused);
  });

  it('выбор строк от другой описи — отказ: номера строк имеют смысл только в своём снимке', async () => {
    const { box, snap } = await inventory();
    await runContractDownload(box.session, snap, { ...opts(), deadline: new Date(0) });
    const other = { ...snap, createdAt: '2030-01-01T00:00:00.000Z' };
    await expect(runContractDownload(box.session, other, opts())).rejects.toThrow('другой описи');
    expect((await collectDownloadState(outDir, other)).selected).toBeNull();
  });

  it('неизвестный номер строки — отказ', async () => {
    const { box, snap } = await inventory();
    await expect(runContractDownload(box.session, snap, { ...opts(), addRows: [999] })).rejects.toThrow('999');
  });

  it('полная выгрузка: файлы, подписи по сторонам, отказ, согласующая, PDF с повтором и 409', async () => {
    const { box, snap } = await inventory();
    const slept: number[] = [];
    const run = await runContractDownload(box.session, snap, { ...opts(), sleep: async (ms) => void slept.push(ms) });
    expect(run).toMatchObject({ selected: 6, processed: 6, stoppedBy: null, errors: 0 });
    // Повтор печатной формы ждёт не дольше 30 с, даже если Диадок просит две минуты.
    expect(slept).toEqual([30_000]);

    const state = await collectDownloadState(outDir, snap);
    expect(state.complete).toBe(true);
    const e1 = state.rows.get(byEntity(snap, 'e1').row)!;
    expect(e1).toMatchObject({ file: 'скачан', recipientState: 'есть', printForm: 'есть', signatures: { sender: 1, recipient: 1 } });
    expect(state.rows.get(byEntity(snap, 'e2').row)).toMatchObject({ printForm: 'недоступна', complete: true });
    expect(state.rows.get(byEntity(snap, 'e8').row)).toMatchObject({
      signatures: { sender: 1, approvement: 1, recipient: 0 },
      recipientState: 'неизвестно',
    });
    expect(state.rows.get(byEntity(snap, 'e9').row)).toMatchObject({ recipientState: 'отказ', signatures: { sender: 1 } });
    expect(state.rows.has(byEntity(snap, 'e6').row)).toBe(false); // на просмотр — не выбран

    const dir = path.join(outDir, e1.dir!);
    expect(await readFile(path.join(dir, 'Договор поставки 1.pdf'), 'utf-8')).toBe('%PDF-1.4 e1');
    // Имя подписи — от её идентификатора, а не от порядка в ответе.
    expect(await readFile(path.join(dir, 'Договор поставки 1 — подпись отправителя s1.sig'), 'utf-8')).toBe('SIG s1');
    expect(await readFile(path.join(dir, 'Договор поставки 1 — подпись получателя s2.sig'), 'utf-8')).toBe('SIG s2');
    expect(await readFile(path.join(dir, 'печатная форма.pdf'), 'utf-8')).toBe('%PDF-1.4 print e1');
    expect(e1.dir).toContain('files/ООО Альфа (7700000001)/');
    const e9 = state.rows.get(byEntity(snap, 'e9').row)!;
    expect(e9.dir).toContain('_аннулированные и отклонённые');
  });

  it('спорные строки — только по выбору: категорией или номером', async () => {
    const { box, snap } = await inventory();
    await runContractDownload(box.session, snap, { ...opts(), include: ['spec'] });
    let state = await collectDownloadState(outDir, snap);
    expect(state.rows.has(byEntity(snap, 'e6').row)).toBe(true);
    await runContractDownload(box.session, snap, { ...opts(), addRows: [byEntity(snap, 'e7').row] });
    state = await collectDownloadState(outDir, snap);
    // Выбор копится: категория из прошлого запуска не потерялась.
    expect(state.selected).toMatchObject({ include: ['spec'], addRows: [byEntity(snap, 'e7').row] });
    expect(state.rows.has(byEntity(snap, 'e6').row)).toBe(true);
    expect(state.complete).toBe(true);
  });

  it('--limit оставляет выгрузку незавершённой, повторный запуск продолжает', async () => {
    const { box, snap } = await inventory();
    const first = await runContractDownload(box.session, snap, { ...opts(), limit: 2 });
    expect(first).toMatchObject({ processed: 2, stoppedBy: 'limit' });
    let state = await collectDownloadState(outDir, snap);
    expect(state).toMatchObject({ complete: false, done: 2, pending: 4 });

    const contentCalls = box.calls.getEntityContent;
    const second = await runContractDownload(box.session, snap, opts());
    expect(second).toMatchObject({ processed: 4, stoppedBy: null });
    state = await collectDownloadState(outDir, snap);
    expect(state.complete).toBe(true);
    // Готовое повторно не качается: 4 оставшихся документа + их 5 подписей (у ДС — две).
    expect(box.calls.getEntityContent - contentCalls).toBe(4 + 5);
  });

  it('файл с отметкой «скачано», но короче записанного — не готов и качается заново', async () => {
    const { box, snap } = await inventory();
    await runContractDownload(box.session, snap, opts());
    const progress = await readProgress(outDir);
    const rec = progress.get('m1/e1/file') as { path: string };
    await truncate(path.join(outDir, rec.path), 3);
    let state = await collectDownloadState(outDir, snap);
    expect(state.complete).toBe(false);
    expect(state.rows.get(byEntity(snap, 'e1').row)!.missing).toContain('исходный файл (другой размер)');

    await runContractDownload(box.session, snap, opts());
    state = await collectDownloadState(outDir, snap);
    expect(state.complete).toBe(true);
    expect((await stat(path.join(outDir, rec.path))).size).toBe('%PDF-1.4 e1'.length);
  });

  it('подпись, появившаяся после описи, находится повторным GetMessage', async () => {
    const { box, snap } = await inventory();
    box.messages.m1!.Entities.push(sig('s1b', 'e1', BOX));
    await runContractDownload(box.session, snap, opts());
    const state = await collectDownloadState(outDir, snap);
    const e1 = state.rows.get(byEntity(snap, 'e1').row)!;
    expect(e1).toMatchObject({ newSignatures: 1, signatures: { recipient: 2 }, complete: true });
    expect(await readFile(path.join(outDir, e1.dir!, 'Договор поставки 1 — подпись получателя s1b.sig'), 'utf-8')).toBe('SIG s1b');
  });

  it('печатная форма не готова за все попытки — ошибка, выгрузка не завершена', async () => {
    const { box, snap } = await inventory();
    await runContractDownload(box.session, snap, {
      ...opts(),
      printFormAttempts: 3,
      sleep: async () => {},
    });
    // В этом запуске форма e1 готова со второй попытки — всё сходится.
    expect((await collectDownloadState(outDir, snap)).complete).toBe(true);

    const other = await mkdtemp(path.join(os.tmpdir(), 'edo-contracts-'));
    try {
      const stuck = fakeBox({ printForm: () => ({ state: 'retry', afterMs: 1000 }) });
      await runContractDownload(stuck.session, snap, { ...opts(), outDir: other, printFormAttempts: 3 });
      const state = await collectDownloadState(other, snap);
      expect(state.complete).toBe(false);
      expect(state.rows.get(byEntity(snap, 'e1').row)).toMatchObject({ printForm: 'ошибка', error: 'форма не готова за 3 попыток' });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('время вышло — ничего не начато, выгрузка не завершена', async () => {
    const { box, snap } = await inventory();
    const run = await runContractDownload(box.session, snap, { ...opts(), deadline: new Date(0) });
    expect(run).toMatchObject({ processed: 0, stoppedBy: 'deadline' });
    expect((await collectDownloadState(outDir, snap)).complete).toBe(false);
  });

  it('пауза перед каждым запросом к Диадоку', async () => {
    const { box, snap } = await inventory();
    const slept: number[] = [];
    const run = await runContractDownload(box.session, snap, {
      ...opts(),
      pauseMs: 150,
      sleep: async (ms) => void slept.push(ms),
    });
    // Каждый запрос — с паузой; плюс одно ожидание печатной формы e1 (30 с).
    expect(slept.filter((ms) => ms === 150)).toHaveLength(run.requests);
    expect(slept.filter((ms) => ms !== 150)).toEqual([30_000]);
  });

  it('мало места на диске — аккуратная остановка, выгрузка не завершена', async () => {
    const { box, snap } = await inventory();
    let free = 10 * 1024 ** 3;
    const run = await runContractDownload(box.session, snap, {
      ...opts(),
      minFreeBytes: 5 * 1024 ** 3,
      // Проверка — перед сообщением и перед каждым документом; каждая видит на 3 ГБ меньше:
      // 10 (сообщение m1) → 7 (документ e1) → 4 < 5 (документ e2) — стоп.
      freeBytes: async () => {
        const now = free;
        free -= 3 * 1024 ** 3;
        return now;
      },
    });
    expect(run).toMatchObject({ stoppedBy: 'disk', processed: 1 });
    expect((await collectDownloadState(outDir, snap)).complete).toBe(false);
  });

  it('перестановка подписей и новая подпись при продолжении не перезаписывают скачанные', async () => {
    const { box, snap } = await inventory();
    await runContractDownload(box.session, snap, opts());
    const progress = await readProgress(outDir);
    const print = progress.get('m1/e1/printform') as { path: string };
    await truncate(path.join(outDir, print.path), 1); // e1 снова «недоделан»
    // Диадок отдал подписи в другом порядке и добавил новую ответную — первой.
    const m1 = box.messages.m1!;
    const sigs = m1.Entities.filter((e) => e.ParentEntityId === 'e1');
    m1.Entities = [
      sig('s0', 'e1', BOX),
      ...m1.Entities.filter((e) => e.ParentEntityId !== 'e1').reverse(),
      ...sigs.reverse(),
    ];
    await runContractDownload(box.session, snap, opts());
    const state = await collectDownloadState(outDir, snap);
    const e1 = state.rows.get(byEntity(snap, 'e1').row)!;
    expect(e1).toMatchObject({ complete: true, signatures: { sender: 1, recipient: 2 } });
    const dir = path.join(outDir, e1.dir!);
    expect(await readFile(path.join(dir, 'Договор поставки 1 — подпись отправителя s1.sig'), 'utf-8')).toBe('SIG s1');
    expect(await readFile(path.join(dir, 'Договор поставки 1 — подпись получателя s2.sig'), 'utf-8')).toBe('SIG s2');
    expect(await readFile(path.join(dir, 'Договор поставки 1 — подпись получателя s0.sig'), 'utf-8')).toBe('SIG s0');
  });

  it('--verify ловит подмену содержимого при том же размере', async () => {
    const { box, snap } = await inventory();
    await runContractDownload(box.session, snap, opts());
    const rec = (await readProgress(outDir)).get('m1/e1/file') as { path: string };
    await writeFile(path.join(outDir, rec.path), '%PDF-1.4 XX'); // тот же размер, другое содержимое
    expect((await collectDownloadState(outDir, snap)).complete).toBe(true); // по размеру не видно
    const verified = await collectDownloadState(outDir, snap, { checkHashes: true });
    expect(verified.complete).toBe(false);
    expect(verified.rows.get(byEntity(snap, 'e1').row)!.missing).toContain('исходный файл (sha256 не совпал)');
  });

  it('после --verify с пометкой испорченный файл перекачивается, без пометки журнал не трогается', async () => {
    const { box, snap } = await inventory();
    await runContractDownload(box.session, snap, opts());
    const rec = (await readProgress(outDir)).get('m1/e1/file') as { path: string };
    const full = path.join(outDir, rec.path);
    await writeFile(full, '%PDF-1.4 XX'); // тот же размер, другое содержимое

    const recordsBefore = (await readFile(path.join(outDir, 'progress.jsonl'), 'utf-8')).length;
    expect((await collectDownloadState(outDir, snap, { checkHashes: true })).marked).toBe(0);
    expect((await readFile(path.join(outDir, 'progress.jsonl'), 'utf-8')).length).toBe(recordsBefore);

    const verified = await collectDownloadState(outDir, snap, { checkHashes: true, markBroken: true });
    expect(verified).toMatchObject({ complete: false, marked: 1 });
    expect((await readProgress(outDir)).get('m1/e1/file')).toMatchObject({ outcome: 'error', reason: 'при проверке: sha256 не совпал' });

    const contentCalls = box.calls.getEntityContent;
    await runContractDownload(box.session, snap, opts());
    expect(box.calls.getEntityContent - contentCalls).toBe(1); // ровно испорченный файл
    expect(await readFile(full, 'utf-8')).toBe('%PDF-1.4 e1');
    expect((await collectDownloadState(outDir, snap, { checkHashes: true, markBroken: true })).complete).toBe(true);
  });

  it('граница части: печатная форма, которая не успевает, откладывается без ошибки', async () => {
    const { box, snap } = await inventory();
    let clock = Date.UTC(2026, 10, 2, 18, 0);
    const run = await runContractDownload(box.session, snap, {
      ...opts(),
      now: () => new Date(clock),
      sleep: async (ms) => void (clock += ms),
      hardDeadline: new Date(clock + 10_000), // ожидание формы e1 (30 с) за границу не влезает
    });
    expect(run).toMatchObject({ stoppedBy: 'deadline', processed: 0, errors: 0 });
    const progress = await readProgress(outDir);
    expect(progress.get('m1/e1/file')).toMatchObject({ outcome: 'done' });
    expect(progress.has('m1/e1/printform')).toBe(false); // ни «ошибки», ни «готово» — доделает следующая часть
    await runContractDownload(box.session, snap, opts());
    expect((await collectDownloadState(outDir, snap)).complete).toBe(true);
  });

  it('граница части уже пройдена — ни одного запроса, ни одной записи', async () => {
    const { box, snap } = await inventory();
    const before = box.calls.getMessage;
    const run = await runContractDownload(box.session, snap, { ...opts(), hardDeadline: new Date(0) });
    expect(run).toMatchObject({ stoppedBy: 'deadline', requests: 0 });
    expect(box.calls.getMessage).toBe(before);
    expect((await readProgress(outDir)).size).toBe(0);
  });

  it('отказ уровня учётки (402) останавливает прогон без ошибок у остальных строк', async () => {
    const { snap } = await inventory();
    const box = fakeBox({ contentError: (id) => (id === 'e2' ? new DiadocSubscriptionExpired() : null) });
    const run = await runContractDownload(box.session, snap, opts());
    expect(run).toMatchObject({ stoppedBy: 'diadoc_unavailable', processed: 1, errors: 0 });
    expect(run.stopReason).toContain('402');
    const records = [...(await readProgress(outDir)).values()];
    expect(records.filter((r) => 'outcome' in r && r.outcome === 'error')).toEqual([]);
    expect(records.some((r) => r.key.startsWith('m5/') || r.key.startsWith('m6/'))).toBe(false);
    // Причина устранена — продолжение с того же места.
    await runContractDownload(fakeBox().session, snap, opts());
    expect((await collectDownloadState(outDir, snap)).complete).toBe(true);
  });

  it('нет одного документа (404) — ошибка только у этой строки, остальные скачаны', async () => {
    const { snap } = await inventory();
    const box = fakeBox({ contentError: (id) => (id === 'e2' ? new DiadocGone(404) : null) });
    const run = await runContractDownload(box.session, snap, opts());
    expect(run).toMatchObject({ stoppedBy: null, processed: 6, errors: 1 });
    const state = await collectDownloadState(outDir, snap);
    expect(state).toMatchObject({ complete: false, done: 5, pending: 1 });
    expect(state.rows.get(byEntity(snap, 'e2').row)!.error).toContain('404');
  });

  it('потеря лиза — остановка без исключения наружу', async () => {
    const { snap } = await inventory();
    const box = fakeBox({ leaseLostAfter: 3 });
    const run = await runContractDownload(box.session, snap, opts());
    expect(run.stoppedBy).toBe('lease_lost');
    expect((await collectDownloadState(outDir, snap)).complete).toBe(false);
  });
});

describe('ответная подпись', () => {
  const entity = (need?: boolean) => ({ EntityId: 'e', ...(need === undefined ? {} : { NeedRecipientSignature: need }) }) as DiadocEntity;
  it('«не требуется» — только у неформализованного с явным false', () => {
    expect(recipientStateOf(entity(false), 'Nonformalized', 0, false)).toBe('не требуется');
    expect(recipientStateOf(entity(), 'Nonformalized', 0, false)).toBe('неизвестно');
    expect(recipientStateOf(entity(false), 'Contract', 0, false)).toBe('неизвестно');
    expect(recipientStateOf(entity(true), 'Nonformalized', 0, false)).toBe('ещё не подписан');
    expect(recipientStateOf(entity(true), 'Nonformalized', 0, true)).toBe('отказ');
    expect(recipientStateOf(entity(true), 'Nonformalized', 1, true)).toBe('есть');
  });
});

describe('опись в Excel', () => {
  it('листы описи и колонки состояний после выгрузки', async () => {
    const { box, snap } = await inventory();
    await runContractDownload(box.session, snap, opts());
    const file = path.join(outDir, 'опись.xlsx');
    await writeContractsXlsx(file, snap, await collectDownloadState(outDir, snap));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Сводка',
      'Берём',
      'На просмотр',
      'Похожие — исключены',
      'Не распознаны',
      'По годам',
      'Окна',
      'Типы ящика',
    ]);
    expect(wb.getWorksheet('Берём')!.rowCount).toBe(1 + 6);
    const header = (wb.getWorksheet('Берём')!.getRow(1).values as unknown[]).filter(Boolean);
    expect(header).toContain('Печатная форма');
  });

  function opts() {
    return { outDir, include: [], addRows: [], maxFileBytes: 1024 * 1024, sleep: async () => {} };
  }
});

describe('исход работы под лизом', () => {
  it('опись со счётчиками в поле skipped — не отказ; отказ — только строка из списка', async () => {
    const { snap } = await inventory();
    expect(snap.skipped).toEqual({ test: 0, deleted: 0, deletedInPackages: 0 });
    expect(isRunnerSkipped(snap)).toBe(false);
    expect(isRunnerSkipped({ skipped: 'lease_taken' })).toBe(true);
    expect(isRunnerSkipped({ skipped: 'not_found' })).toBe(true);
    expect(isRunnerSkipped({ skipped: 'другое' })).toBe(false);
    expect(isRunnerSkipped(null)).toBe(false);
  });
});
