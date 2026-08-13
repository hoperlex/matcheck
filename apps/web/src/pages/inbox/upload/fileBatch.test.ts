import { describe, expect, it } from 'vitest';
import { addFileBatch, rejectionMessage, type FileRow } from './fileBatch';

// Нужны только имя и размер — остальное в File для этой логики не участвует.
function f(name: string, size = 1000): File {
  return { name, size } as unknown as File;
}

function row(name: string, size = 1000): FileRow {
  return { uid: `uid-${name}`, file: f(name, size) };
}

const uid = (file: File, index: number) => `u${index}-${file.name}`;

describe('addFileBatch', () => {
  it('добавляет всю пачку, а не последний файл', () => {
    const r = addFileBatch({
      prev: [],
      otherZone: [],
      files: [f('a.pdf'), f('b.pdf'), f('c.pdf')],
      makeUid: uid,
    });

    expect(r.next.map((x) => x.file.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(r.rejected).toEqual([]);
  });

  it('дописывает пачку к уже выбранным файлам', () => {
    const r = addFileBatch({
      prev: [row('old.pdf')],
      otherZone: [],
      files: [f('new1.pdf'), f('new2.pdf')],
      makeUid: uid,
    });

    expect(r.next.map((x) => x.file.name)).toEqual(['old.pdf', 'new1.pdf', 'new2.pdf']);
  });

  it('не мутирует переданный список', () => {
    const prev = [row('old.pdf')];
    addFileBatch({ prev, otherZone: [], files: [f('new.pdf')], makeUid: uid });
    expect(prev).toHaveLength(1);
  });

  it('отсеивает файл, уже добавленный в другую зону, но пропускает остальные', () => {
    const r = addFileBatch({
      prev: [],
      otherZone: [row('cert.pdf', 2048)],
      files: [f('upd.pdf'), f('cert.pdf', 2048), f('waybill.pdf')],
      makeUid: uid,
    });

    expect(r.next.map((x) => x.file.name)).toEqual(['upd.pdf', 'waybill.pdf']);
    expect(r.rejected).toEqual([{ name: 'cert.pdf', reason: 'duplicate_other_zone' }]);
  });

  it('файл того же имени, но другого размера — другой файл', () => {
    const r = addFileBatch({
      prev: [],
      otherZone: [row('scan.jpg', 100)],
      files: [f('scan.jpg', 200)],
      makeUid: uid,
    });

    expect(r.next).toHaveLength(1);
    expect(r.rejected).toEqual([]);
  });

  it('схлопывает дубль внутри одной пачки', () => {
    const r = addFileBatch({
      prev: [],
      otherZone: [],
      files: [f('a.pdf'), f('a.pdf'), f('b.pdf')],
      makeUid: uid,
    });

    expect(r.next.map((x) => x.file.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(r.rejected).toEqual([{ name: 'a.pdf', reason: 'duplicate_in_batch' }]);
  });

  it('лимит числа файлов считается по обеим зонам', () => {
    const r = addFileBatch({
      prev: [row('p1.pdf'), row('p2.pdf')],
      otherZone: [row('o1.pdf')],
      files: [f('n1.pdf'), f('n2.pdf')],
      limits: { maxFiles: 4 },
      makeUid: uid,
    });

    expect(r.next.map((x) => x.file.name)).toEqual(['p1.pdf', 'p2.pdf', 'n1.pdf']);
    expect(r.rejected).toEqual([{ name: 'n2.pdf', reason: 'too_many' }]);
  });

  it('слишком большой файл не занимает место в лимите', () => {
    const r = addFileBatch({
      prev: [],
      otherZone: [],
      files: [f('big.pdf', 20), f('ok.pdf', 5)],
      limits: { maxFileBytes: 10, maxFiles: 1 },
      makeUid: uid,
    });

    expect(r.next.map((x) => x.file.name)).toEqual(['ok.pdf']);
    expect(r.rejected).toEqual([{ name: 'big.pdf', reason: 'file_too_large' }]);
  });

  it('суммарный объём учитывает соседнюю зону', () => {
    const r = addFileBatch({
      prev: [row('p.pdf', 40)],
      otherZone: [row('o.pdf', 40)],
      files: [f('n.pdf', 30)],
      limits: { maxTotalBytes: 100 },
      makeUid: uid,
    });

    expect(r.next.map((x) => x.file.name)).toEqual(['p.pdf']);
    expect(r.rejected).toEqual([{ name: 'n.pdf', reason: 'total_too_large' }]);
  });

  it('без лимитов принимает любую пачку', () => {
    const r = addFileBatch({
      prev: [],
      otherZone: [],
      files: Array.from({ length: 30 }, (_, i) => f(`f${i}.pdf`, 50 * 1024 * 1024)),
      makeUid: uid,
    });

    expect(r.next).toHaveLength(30);
    expect(r.rejected).toEqual([]);
  });

  it('выдаёт уникальные uid внутри пачки и без makeUid', () => {
    const r = addFileBatch({
      prev: [],
      otherZone: [],
      files: [f('a.pdf'), f('b.pdf'), f('c.pdf')],
    });

    expect(new Set(r.next.map((x) => x.uid)).size).toBe(3);
  });
});

describe('rejectionMessage', () => {
  it('без отказов — сообщения нет', () => {
    expect(rejectionMessage([])).toBeNull();
  });

  it('один файл — называет его и причину', () => {
    expect(rejectionMessage([{ name: 'cert.pdf', reason: 'duplicate_other_zone' }])).toBe(
      'Файл «cert.pdf» не добавлен: уже добавлен в другую зону',
    );
  });

  it('несколько файлов — одно сообщение со всеми причинами', () => {
    const msg = rejectionMessage([
      { name: 'a.pdf', reason: 'duplicate_other_zone' },
      { name: 'b.pdf', reason: 'too_many' },
      { name: 'c.pdf', reason: 'too_many' },
    ]);

    expect(msg).toBe(
      'Не добавлено файлов: 3 — уже добавлен в другую зону; превышено число файлов в поставке',
    );
  });
});
