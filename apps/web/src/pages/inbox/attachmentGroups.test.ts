/**
 * Группировка вложений письма.
 *
 * Проверяется то, ради чего группировка и сделана: документ виден сразу, гора
 * иконок из подписи не выдавливает карточку, а письмо, состоящее из одних
 * подписей, не выглядит пустым.
 */
import { describe, it, expect } from 'vitest';
import {
  pickActiveAttachment,
  splitAttachments,
  type GroupableAttachment,
} from './attachmentGroups';

const doc = (id: string): GroupableAttachment & { id: string } => ({
  id,
  state: 'kept',
  willBeIngested: true,
});
const restored = (id: string): GroupableAttachment & { id: string } => ({
  id,
  state: 'restored',
  willBeIngested: true,
});
const sig = (id: string): GroupableAttachment & { id: string } => ({
  id,
  state: 'suspected_signature',
  willBeIngested: false,
});
const skipped = (id: string): GroupableAttachment & { id: string } => ({
  id,
  state: 'skipped',
  willBeIngested: false,
});

describe('splitAttachments', () => {
  it('боевое письмо: один документ виден, семь подписей свёрнуты', () => {
    const atts = [doc('upd'), ...Array.from({ length: 7 }, (_, i) => sig(`img${i}`))];

    const g = splitAttachments(atts);

    expect(g.documents.map((a) => a.id)).toEqual(['upd']);
    expect(g.hidden).toHaveLength(7);
    expect(g.hiddenLabel).toBe('Похоже на подписи (7)');
    expect(g.hiddenOpenByDefault).toBe(false);
  });

  it('возвращённое оператором вложение считается документом', () => {
    const g = splitAttachments([restored('back'), sig('img')]);

    expect(g.documents.map((a) => a.id)).toEqual(['back']);
    expect(g.hidden.map((a) => a.id)).toEqual(['img']);
  });

  it('письмо из одних подписей: группа раскрыта, иначе список выглядит пустым', () => {
    const g = splitAttachments([sig('a'), sig('b')]);

    expect(g.documents).toHaveLength(0);
    expect(g.hiddenOpenByDefault).toBe(true);
  });

  it('заголовок не врёт: рядом с подписями отброшенное — формулировка общая', () => {
    const g = splitAttachments([doc('upd'), sig('img'), skipped('setup.exe')]);

    expect(g.hiddenLabel).toBe('Не пойдут в пакет (2)');
  });

  it('прятать нечего — группы нет', () => {
    const g = splitAttachments([doc('a'), doc('b')]);

    expect(g.hidden).toHaveLength(0);
    expect(g.hiddenLabel).toBeNull();
    expect(g.hiddenOpenByDefault).toBe(false);
  });

  it('письмо без вложений не ломает группировку', () => {
    const g = splitAttachments([]);

    expect(g.documents).toHaveLength(0);
    expect(g.hidden).toHaveLength(0);
    expect(g.hiddenLabel).toBeNull();
    // Раскрывать нечего — иначе в карточке появился бы пустой раскрытый блок.
    expect(g.hiddenOpenByDefault).toBe(false);
  });

  it('порядок вложений сохраняется внутри каждой группы', () => {
    const g = splitAttachments([sig('s1'), doc('d1'), sig('s2'), doc('d2')]);

    expect(g.documents.map((a) => a.id)).toEqual(['d1', 'd2']);
    expect(g.hidden.map((a) => a.id)).toEqual(['s1', 's2']);
  });
});

describe('pickActiveAttachment', () => {
  it('показывает документ, а не первую попавшуюся иконку', () => {
    expect(pickActiveAttachment([sig('img'), doc('upd')])).toBe('upd');
  });

  it('документов нет — показывает первое вложение, а не пустоту', () => {
    expect(pickActiveAttachment([sig('img1'), sig('img2')])).toBe('img1');
  });

  it('вложений нет — null', () => {
    expect(pickActiveAttachment([])).toBeNull();
  });
});
