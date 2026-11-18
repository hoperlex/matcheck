/**
 * Геометрия просмотрщика ZoomableImage — чистые функции, без DOM.
 *
 * Модель: картинка натурального размера стоит центром в центре панели и
 * трансформируется как `translate(x, y) rotate(r) scale(fit · z)`.
 *   - fit — масштаб «вписать» для текущего поворота;
 *   - z   — масштаб ОТНОСИТЕЛЬНО «вписать» (1 — кадр целиком в панели);
 *   - x,y — сдвиг центра кадра от центра панели в экранных пикселях.
 *
 * z относительный намеренно: оригинал (2048px) приходит на смену миниатюре
 * (320px) той же пропорции, fit меняется ровно во столько же раз, и видимый
 * размер `natural · fit · z` остаётся прежним — кадр не прыгает, даже если
 * человек уже приблизил и повернул миниатюру.
 */

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };
export type View = { z: number; x: number; y: number };

export const MIN_Z = 1;
export const MAX_Z = 10;
export const FIT_VIEW: View = { z: 1, x: 0, y: 0 };

/** Поворот к 0/90/180/270. Угол в состоянии копится (−90, 450 …) ради анимации. */
export function normRotation(rotation: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** Габарит кадра после поворота: на 90° и 270° стороны меняются местами. */
export function rotatedSize(natural: Size, rotation: number): Size {
  const r = normRotation(rotation);
  return r === 90 || r === 270 ? { w: natural.h, h: natural.w } : natural;
}

/** Масштаб «вписать». 0 — геометрия ещё неизвестна (панель или кадр без размеров). */
export function fitScale(container: Size, natural: Size, rotation: number): number {
  const b = rotatedSize(natural, rotation);
  if (container.w <= 0 || container.h <= 0 || b.w <= 0 || b.h <= 0) return 0;
  return Math.min(container.w / b.w, container.h / b.h);
}

export function clampZ(z: number): number {
  if (!Number.isFinite(z)) return MIN_Z;
  return Math.min(MAX_Z, Math.max(MIN_Z, z));
}

/**
 * Границы сдвига. Кадр уже панели по оси — стоит по центру этой оси. Шире —
 * сдвигается, пока его край не дойдёт до края панели: дальше внутрь панели
 * край не уходит, пустого поля сбоку не бывает.
 */
export function clampOffset(view: View, container: Size, natural: Size, rotation: number): View {
  const z = clampZ(view.z);
  const fit = fitScale(container, natural, rotation);
  if (fit === 0) return { z, x: 0, y: 0 };
  const b = rotatedSize(natural, rotation);
  const maxX = Math.max(0, (b.w * fit * z - container.w) / 2);
  const maxY = Math.max(0, (b.h * fit * z - container.h) / 2);
  return {
    z,
    x: Math.min(maxX, Math.max(-maxX, view.x)),
    y: Math.min(maxY, Math.max(-maxY, view.y)),
  };
}

/**
 * Масштаб с неподвижной точкой, без границ сдвига: то, что было под курсором
 * (точка — от центра панели), под ним и остаётся. Точка кадра под курсором
 * лежит на расстоянии (p − offset) от его центра; после масштаба это
 * расстояние умножается на отношение масштабов, отсюда новый сдвиг.
 * Отдельно от zoomAt — щипку нужно сначала прибавить сдвиг середины пальцев
 * и только потом ограничить.
 */
export function scaleAbout(view: View, nextZ: number, point: Point): View {
  const z = clampZ(nextZ);
  const ratio = z / view.z;
  return { z, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

/** scaleAbout плюс общие границы сдвига. */
export function zoomAt(
  view: View,
  nextZ: number,
  point: Point,
  container: Size,
  natural: Size,
  rotation: number,
): View {
  return clampOffset(scaleAbout(view, nextZ, point), container, natural, rotation);
}

/**
 * Множитель масштаба на одно событие колеса. deltaMode: 0 — пиксели, 1 —
 * строки, 2 — страницы. Щипок на тачпаде браузер присылает как wheel с
 * ctrlKey и мелкими дельтами — у него свой, более крутой коэффициент. Одно
 * событие не больше ±300px: «быстрое» колесо иначе прыгает сразу в предел.
 */
export function wheelFactor(
  e: { deltaY: number; deltaMode: number; ctrlKey: boolean },
  pageHeight: number,
): number {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.max(1, pageHeight) : 1;
  const dy = Math.max(-300, Math.min(300, e.deltaY * unit));
  const k = e.ctrlKey ? 0.01 : 0.0015;
  return Math.exp(-dy * k);
}
