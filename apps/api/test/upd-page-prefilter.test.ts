import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  parseClassification,
  getPerPageRotation,
  detectRotationOsd,
  rotatePng,
} from '../src/domain/edo/upd-page-prefilter.js';
import { pdfToPngsViaPoppler } from '../src/domain/edo/upd-vision.parser.js';

/**
 * Тесты детерминированного prefilter'а PDF перед Vision.
 *
 * Покрывают то, что можно проверить offline (без LLM и без tesseract):
 *  - parseClassification: разбор ответа классификатора + безопасная семантика
 *    отбора (use = страница НЕ сертификат/накладная);
 *  - getPerPageRotation: гейт против двойного поворота — рабочие файлы с
 *    /Rotate≠0 (1697=270, scanlite3=90) НЕ должны попадать под OSD; файлы с
 *    физическим поворотом (su10, upd-214) имеют /Rotate=0 → OSD разрешён.
 *
 * OSD-направление (Tesseract↔Jimp) проверяется отдельным блоком, который
 * выполняется ТОЛЬКО при наличии tesseract в окружении (в Docker-образе он
 * есть; в голом CI без него — skip).
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upd-debug');

const hasTesseract = spawnSync('tesseract', ['--version']).status === 0;

describe('parseClassification — безопасная семантика отбора', () => {
  it('исключает только сертификат и накладную; УПД и other остаются', () => {
    const raw = JSON.stringify({
      pages: [
        { page: 1, type: 'upd_main' },
        { page: 2, type: 'certificate' },
        { page: 3, type: 'transport_waybill' },
        { page: 4, type: 'other' },
        { page: 5, type: 'upd_continuation' },
      ],
    });
    const r = parseClassification(raw, 5);
    expect(r.find((p) => p.page === 1)!.use).toBe(true); // upd_main
    expect(r.find((p) => p.page === 2)!.use).toBe(false); // certificate
    expect(r.find((p) => p.page === 3)!.use).toBe(false); // transport_waybill
    expect(r.find((p) => p.page === 4)!.use).toBe(true); // other — оставляем
    expect(r.find((p) => p.page === 5)!.use).toBe(true); // upd_continuation
  });

  it('принимает голый массив без обёртки {pages:[...]}', () => {
    const r = parseClassification('[{"page":1,"type":"certificate"}]', 1);
    expect(r).toHaveLength(1);
    expect(r[0]!.use).toBe(false);
  });

  it('неизвестный type → other (остаётся, не теряем данные)', () => {
    const r = parseClassification('{"pages":[{"page":1,"type":"weird_thing"}]}', 1);
    expect(r[0]!.type).toBe('other');
    expect(r[0]!.use).toBe(true);
  });

  it('непарсимый JSON → [] (caller уйдёт в fallback на все страницы)', () => {
    expect(parseClassification('not json at all', 3)).toEqual([]);
    expect(parseClassification(null, 3)).toEqual([]);
  });

  it('отбрасывает страницы вне диапазона и дубликаты', () => {
    const r = parseClassification(
      '{"pages":[{"page":0,"type":"upd_main"},{"page":9,"type":"upd_main"},{"page":1,"type":"upd_main"},{"page":1,"type":"certificate"}]}',
      3,
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.page).toBe(1);
    expect(r[0]!.type).toBe('upd_main'); // первая запись побеждает
  });
});

describe('getPerPageRotation — гейт против двойного поворота', () => {
  it('1697.pdf: /Rotate=270 (poppler выпрямляет сам → OSD пропускается)', async () => {
    const rot = await getPerPageRotation(readFileSync(join(fixturesDir, '1697.pdf')));
    expect(rot[0]).toBe(270);
  });

  it('scanlite3.pdf: /Rotate=90 (poppler выпрямляет сам → OSD пропускается)', async () => {
    const rot = await getPerPageRotation(readFileSync(join(fixturesDir, 'scanlite3.pdf')));
    expect(rot[0]).toBe(90);
  });

  it('upd-214.pdf: все 5 страниц /Rotate=0 (физический поворот → OSD разрешён)', async () => {
    const rot = await getPerPageRotation(readFileSync(join(fixturesDir, 'upd-214.pdf')));
    expect(rot.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it('su10-fe.pdf: все 6 страниц /Rotate=0 (физический поворот → OSD разрешён)', async () => {
    const rot = await getPerPageRotation(readFileSync(join(fixturesDir, 'su10-fe.pdf')));
    expect(rot.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

// OSD-направление: требует реального tesseract (в Docker есть). Проверяем
// self-consistency: повёрнутую боком УПД-страницу OSD определяет как 90/270,
// после rotatePng на этот угол повторный OSD должен дать 0 — это и есть
// доказательство, что знак поворота (JIMP_POSITIVE_IS_CCW) выбран верно.
describe.skipIf(!hasTesseract)('detectRotationOsd + rotatePng — направление', () => {
  it('su10-fe стр.1 (боком) → OSD 90/270 → после поворота OSD=0', async () => {
    const buf = readFileSync(join(fixturesDir, 'su10-fe.pdf'));
    const [png] = await pdfToPngsViaPoppler(buf, 1);
    const osd = await detectRotationOsd(png!);
    expect(osd.confidence).toBeGreaterThan(0);
    expect([90, 180, 270]).toContain(osd.rotate);

    const fixed = await rotatePng(png!, osd.rotate);
    const osd2 = await detectRotationOsd(fixed);
    expect(osd2.rotate).toBe(0); // выпрямлено в правильную сторону
  });

  it('rotatePng(0) возвращает исходный буфер без изменений', async () => {
    const buf = readFileSync(join(fixturesDir, 'su10-fe.pdf'));
    const [png] = await pdfToPngsViaPoppler(buf, 1);
    const same = await rotatePng(png!, 0);
    expect(same).toBe(png);
  });
});
