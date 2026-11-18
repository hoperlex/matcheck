import { describe, expect, it } from 'vitest';
import {
  clampOffset,
  fitScale,
  MAX_Z,
  normRotation,
  rotatedSize,
  scaleAbout,
  wheelFactor,
  zoomAt,
  type Point,
  type Size,
  type View,
} from './zoomMath';

const panel: Size = { w: 800, h: 600 };
const scan: Size = { w: 1536, h: 2048 };

/**
 * Экранная точка → точка кадра (в натуральных пикселях от центра кадра).
 * Обратное к transform компонента: translate(x,y) rotate(r) scale(fit·z).
 */
function toImage(p: Point, v: View, natural: Size, rotation: number): Point {
  const s = fitScale(panel, natural, rotation) * v.z;
  const dx = (p.x - v.x) / s;
  const dy = (p.y - v.y) / s;
  const rad = (-normRotation(rotation) * Math.PI) / 180;
  return {
    x: dx * Math.cos(rad) - dy * Math.sin(rad),
    y: dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

describe('zoomMath', () => {
  it('поворот на 90° и 270° меняет стороны, накопленный угол нормализуется', () => {
    expect(rotatedSize(scan, 90)).toEqual({ w: 2048, h: 1536 });
    expect(rotatedSize(scan, 180)).toEqual(scan);
    expect(rotatedSize(scan, -90)).toEqual({ w: 2048, h: 1536 });
    expect(normRotation(450)).toBe(90);
    expect(normRotation(-90)).toBe(270);
    // Портрет в альбомной панели вписывается по высоте, повёрнутый — по ширине.
    expect(fitScale(panel, scan, 0)).toBeCloseTo(600 / 2048);
    expect(fitScale(panel, scan, 90)).toBeCloseTo(Math.min(800 / 2048, 600 / 1536));
  });

  it('без размеров панели или кадра «вписать» неизвестен', () => {
    expect(fitScale({ w: 0, h: 600 }, scan, 0)).toBe(0);
    expect(fitScale(panel, { w: 0, h: 0 }, 0)).toBe(0);
    expect(clampOffset({ z: 3, x: 50, y: 50 }, { w: 0, h: 0 }, scan, 0)).toEqual({
      z: 3,
      x: 0,
      y: 0,
    });
  });

  it('zoomAt держит под курсором ту же точку кадра — и при повороте', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const start: View = { z: 2, x: 30, y: -20 };
      const cursor: Point = { x: 120, y: -80 };
      const before = toImage(cursor, start, scan, rotation);
      const after = zoomAt(start, 3, cursor, panel, scan, rotation);
      const moved = toImage(cursor, after, scan, rotation);
      expect(moved.x).toBeCloseTo(before.x, 6);
      expect(moved.y).toBeCloseTo(before.y, 6);
    }
  });

  it('кадр уже панели стоит по центру; шире — край не уходит внутрь панели', () => {
    // z = 1: высота кадра = высоте панели, ширина меньше — сдвиг обнуляется.
    expect(clampOffset({ z: 1, x: 100, y: 100 }, panel, scan, 0)).toEqual({ z: 1, x: 0, y: 0 });
    // z = 4: кадр 1800×2400 на экране → max сдвиг (1800−800)/2 и (2400−600)/2.
    const clamped = clampOffset({ z: 4, x: 10_000, y: -10_000 }, panel, scan, 0);
    expect(clamped.x).toBeCloseTo(500);
    expect(clamped.y).toBeCloseTo(-900);
  });

  it('масштаб ограничен 1…MAX_Z', () => {
    expect(zoomAt({ z: 1, x: 0, y: 0 }, 0.2, { x: 0, y: 0 }, panel, scan, 0).z).toBe(1);
    expect(zoomAt({ z: 9, x: 0, y: 0 }, 50, { x: 0, y: 0 }, panel, scan, 0).z).toBe(MAX_Z);
    expect(scaleAbout({ z: 2, x: 0, y: 0 }, Number.NaN, { x: 0, y: 0 }).z).toBe(1);
  });

  it('колесо: строки и страницы приводятся к пикселям, рывок ограничен', () => {
    const px = wheelFactor({ deltaY: 48, deltaMode: 0, ctrlKey: false }, 600);
    const lines = wheelFactor({ deltaY: 3, deltaMode: 1, ctrlKey: false }, 600);
    expect(lines).toBeCloseTo(px);
    expect(wheelFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false }, 600)).toBeGreaterThan(1);
    expect(wheelFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false }, 600)).toBeLessThan(1);
    // Одна «страница» и 10 000px дают тот же предельный шаг.
    expect(wheelFactor({ deltaY: 1, deltaMode: 2, ctrlKey: false }, 600)).toBeCloseTo(
      wheelFactor({ deltaY: 10_000, deltaMode: 0, ctrlKey: false }, 600),
    );
    // Щипок тачпада (ctrlKey) с мелкой дельтой масштабирует заметнее.
    expect(wheelFactor({ deltaY: 10, deltaMode: 0, ctrlKey: true }, 600)).toBeLessThan(
      wheelFactor({ deltaY: 10, deltaMode: 0, ctrlKey: false }, 600),
    );
  });

  it('миниатюра → оригинал той же пропорции: видимый размер и сдвиг не меняются', () => {
    const thumb: Size = { w: 240, h: 320 };
    for (const rotation of [0, 90]) {
      const v = clampOffset({ z: 3, x: 140, y: -60 }, panel, thumb, rotation);
      const onScreen = (n: Size) => n.w * fitScale(panel, n, rotation) * v.z;
      expect(onScreen(scan)).toBeCloseTo(onScreen(thumb));
      // Те же границы — сдвиг, допустимый для миниатюры, допустим и для оригинала.
      expect(clampOffset(v, panel, scan, rotation)).toEqual({
        z: v.z,
        x: expect.closeTo(v.x, 6),
        y: expect.closeTo(v.y, 6),
      });
    }
  });
});
