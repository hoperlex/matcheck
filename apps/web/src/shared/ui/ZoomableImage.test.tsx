// @vitest-environment jsdom
/**
 * Просмотрщик скана: зум колесом без клика, перетаскивание, поворот, жесты.
 *
 * В jsdom нет раскладки: размеры панели и кадра задаём руками (clientWidth у
 * панели, naturalWidth у картинки + событие load), getBoundingClientRect
 * везде нулевой — значит, экранная точка (cx, cy) лежит на (cx − 400, cy − 300)
 * от центра панели 800×600. PointerEvent в jsdom нет — подставляем на базе
 * MouseEvent.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZoomableImage } from './ZoomableImage';

let panelW = 800;
let panelH = 600;
const roCallbacks: Array<() => void> = [];
const restore: Array<() => void> = [];

beforeAll(() => {
  if (!('PointerEvent' in window)) {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? 'mouse';
      }
    }
    (window as unknown as Record<string, unknown>).PointerEvent = PointerEventPolyfill;
    restore.push(() => {
      delete (window as unknown as Record<string, unknown>).PointerEvent;
    });
  }
  const prevRO = window.ResizeObserver;
  window.ResizeObserver = class {
    constructor(cb: () => void) {
      roCallbacks.push(cb);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  restore.push(() => {
    window.ResizeObserver = prevRO;
  });
  for (const [prop, get] of [
    ['clientWidth', () => panelW],
    ['clientHeight', () => panelH],
  ] as const) {
    const prev = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-zoomable-image') ? get() : 0;
      },
    });
    restore.push(() => {
      if (prev) Object.defineProperty(HTMLElement.prototype, prop, prev);
    });
  }
});

afterAll(() => {
  for (const r of restore.reverse()) r();
});

afterEach(() => {
  cleanup();
  panelW = 800;
  panelH = 600;
  roCallbacks.length = 0;
});

function loadImage(img: HTMLElement, w: number, h: number): void {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h });
  fireEvent.load(img);
}

/** Геометрия картинки из её inline-стиля. */
function geom(img: HTMLElement): { w: number; h: number; x: number; y: number; r: number } {
  const t = img.style.transform;
  const tr = /translate\(-50%, -50%\) translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\)/.exec(t);
  const rot = /rotate\((-?[\d.]+)deg\)/.exec(t);
  return {
    w: parseFloat(img.style.width),
    h: parseFloat(img.style.height),
    x: tr ? parseFloat(tr[1]!) : NaN,
    y: tr ? parseFloat(tr[2]!) : NaN,
    r: rot ? parseFloat(rot[1]!) : NaN,
  };
}

/** Точка экрана → доля по кадру (0…1) — для неповёрнутого кадра. */
function fractionUnder(img: HTMLElement, cx: number, cy: number): { fx: number; fy: number } {
  const g = geom(img);
  const left = panelW / 2 + g.x - g.w / 2;
  const top = panelH / 2 + g.y - g.h / 2;
  return { fx: (cx - left) / g.w, fy: (cy - top) / g.h };
}

function setup(props: Partial<Parameters<typeof ZoomableImage>[0]> = {}) {
  const utils = render(<ZoomableImage src="blob:scan" alt="Скан" {...props} />);
  const img = screen.getByAltText('Скан');
  const panel = img.parentElement!;
  return { ...utils, img, panel };
}

function wheel(panel: HTMLElement, deltaY: number, clientX: number, clientY: number): WheelEvent {
  const ev = new WheelEvent('wheel', { deltaY, clientX, clientY, bubbles: true, cancelable: true });
  act(() => {
    panel.dispatchEvent(ev);
  });
  return ev;
}

const percent = () => screen.getByLabelText('Масштаб').textContent;

describe('ZoomableImage', () => {
  it('колесо без клика масштабирует в точке курсора и гасит прокрутку', () => {
    const { img, panel } = setup();
    loadImage(img, 1536, 2048);
    // «Вписать»: портрет 1536×2048 в панели 800×600 — по высоте.
    expect(geom(img).h).toBeCloseTo(600);
    expect(geom(img).w).toBeCloseTo(450);

    const before = fractionUnder(img, 500, 350);
    const ev = wheel(panel, -300, 500, 350);
    expect(ev.defaultPrevented).toBe(true);
    expect(geom(img).h).toBeGreaterThan(600);
    const after = fractionUnder(img, 500, 350);
    // Под курсором та же точка листа (здесь кадр уже панели по ширине — по
    // горизонтали он остаётся по центру, проверяем вертикаль и масштаб).
    expect(after.fy).toBeCloseTo(before.fy, 3);
    expect(percent()).not.toBe('100%');
  });

  it('точка под курсором неподвижна и по обеим осям, когда кадр шире панели', () => {
    const { img, panel } = setup();
    loadImage(img, 1536, 2048);
    wheel(panel, -300, 400, 300); // сначала увеличить, чтобы кадр стал шире панели
    wheel(panel, -300, 400, 300);
    const before = fractionUnder(img, 520, 380);
    wheel(panel, -200, 520, 380);
    const after = fractionUnder(img, 520, 380);
    expect(after.fx).toBeCloseTo(before.fx, 3);
    expect(after.fy).toBeCloseTo(before.fy, 3);
  });

  it('пока размеры кадра неизвестны, колесо не перехватывается', () => {
    const { panel } = setup();
    const ev = wheel(panel, -100, 400, 300);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('поворот, кнопки масштаба и «Вписать»', () => {
    const onRotationChange = vi.fn();
    const { img } = setup({ onRotationChange });
    loadImage(img, 1536, 2048);

    fireEvent.click(screen.getByLabelText('Повернуть вправо'));
    expect(geom(img).r).toBe(90);
    expect(onRotationChange).toHaveBeenLastCalledWith(90);
    // Повёрнутый портрет лёг на бок и вписан целиком: элемент 600×800, после
    // поворота на экране 800×600 — ровно панель (fit = 800/2048 = 600/1536).
    expect(geom(img).w).toBeCloseTo(600);
    expect(geom(img).h).toBeCloseTo(800);

    fireEvent.click(screen.getByLabelText('Увеличить'));
    expect(percent()).toBe('150%');
    fireEvent.click(screen.getByLabelText('Вписать'));
    expect(percent()).toBe('100%');

    fireEvent.click(screen.getByLabelText('Повернуть влево'));
    fireEvent.click(screen.getByLabelText('Повернуть влево'));
    // Угол копится, а не прыгает 0 → 270: анимация крутит в нужную сторону.
    expect(geom(img).r).toBe(-90);
    expect(onRotationChange).toHaveBeenLastCalledWith(-90);
  });

  it('стартовый поворот берётся из initialRotation', () => {
    const { img } = setup({ initialRotation: 270 });
    loadImage(img, 1536, 2048);
    expect(geom(img).r).toBe(270);
  });

  it('двойной клик приближает, повторный — вписывает', () => {
    const { img, panel } = setup();
    loadImage(img, 1536, 2048);
    fireEvent.doubleClick(panel, { clientX: 400, clientY: 300 });
    expect(percent()).toBe('250%');
    fireEvent.doubleClick(panel, { clientX: 400, clientY: 300 });
    expect(percent()).toBe('100%');
  });

  it('перетаскивание: при 100% кадр стоит, увеличенный упирается в край панели', () => {
    const { img, panel } = setup();
    loadImage(img, 1536, 2048);

    fireEvent.pointerDown(panel, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(panel, { pointerId: 1, clientX: 600, clientY: 500 });
    fireEvent.pointerUp(panel, { pointerId: 1 });
    expect(geom(img).x).toBe(0);
    expect(geom(img).y).toBe(0);

    fireEvent.doubleClick(panel, { clientX: 400, clientY: 300 }); // 250%
    const g = geom(img);
    fireEvent.pointerDown(panel, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(panel, { pointerId: 1, clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(panel, { pointerId: 1 });
    // Левый и верхний края кадра дошли ровно до краёв панели — не дальше.
    expect(geom(img).x).toBeCloseTo((g.w - panelW) / 2);
    expect(geom(img).y).toBeCloseTo((g.h - panelH) / 2);
    const left = panelW / 2 + geom(img).x - g.w / 2;
    expect(left).toBeCloseTo(0);

    fireEvent.pointerDown(panel, { pointerId: 1, clientX: 5000, clientY: 5000, button: 0 });
    fireEvent.pointerMove(panel, { pointerId: 1, clientX: -5000, clientY: -5000 });
    fireEvent.pointerUp(panel, { pointerId: 1 });
    // Правый и нижний края — тоже до краёв панели.
    const right = panelW / 2 + geom(img).x + g.w / 2;
    const bottom = panelH / 2 + geom(img).y + g.h / 2;
    expect(right).toBeCloseTo(panelW);
    expect(bottom).toBeCloseTo(panelH);
  });

  it('pointercancel и lostpointercapture посреди жеста — кадр не прыгает', () => {
    const { img, panel } = setup();
    loadImage(img, 1536, 2048);
    fireEvent.doubleClick(panel, { clientX: 400, clientY: 300 });

    fireEvent.pointerDown(panel, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(panel, { pointerId: 1, clientX: 380, clientY: 290 });
    const mid = geom(img);
    // Браузер забрал жест себе: дальнейшие движения этого пальца не наши.
    fireEvent.pointerCancel(panel, { pointerId: 1 });
    fireEvent.pointerMove(panel, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(geom(img)).toEqual(mid);
    // lostpointercapture после cancel — повторное снятие, ничего не меняет.
    fireEvent(
      panel,
      new window.PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }),
    );
    expect(geom(img)).toEqual(mid);
  });

  it('щипок двумя пальцами, затем один палец продолжает без скачка', () => {
    const { img, panel } = setup();
    loadImage(img, 1536, 2048);
    const touch = { pointerType: 'touch' };

    fireEvent.pointerDown(panel, { ...touch, pointerId: 1, clientX: 350, clientY: 300 });
    fireEvent.pointerDown(panel, { ...touch, pointerId: 2, clientX: 450, clientY: 300 });
    // Пальцы разошлись вдвое — масштаб вдвое.
    fireEvent.pointerMove(panel, { ...touch, pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(panel, { ...touch, pointerId: 2, clientX: 500, clientY: 300 });
    expect(percent()).toBe('200%');

    // Третий палец игнорируется.
    fireEvent.pointerDown(panel, { ...touch, pointerId: 3, clientX: 100, clientY: 100 });
    expect(percent()).toBe('200%');

    fireEvent.pointerUp(panel, { ...touch, pointerId: 2 });
    const afterLift = geom(img);
    expect(percent()).toBe('200%');
    // Оставшийся палец двигает кадр ровно на свой ход от ТЕКУЩЕЙ точки.
    fireEvent.pointerMove(panel, { ...touch, pointerId: 1, clientX: 290, clientY: 295 });
    expect(geom(img).x).toBeCloseTo(afterLift.x - 10);
    expect(geom(img).y).toBeCloseTo(afterLift.y - 5);
  });

  it('touch-action: свайп листает окно только при «вписать» и только с touchScroll', () => {
    const scroll = setup({ touchScroll: true });
    loadImage(scroll.img, 1536, 2048);
    expect(scroll.panel.style.touchAction).toBe('pan-y');
    fireEvent.click(screen.getByLabelText('Увеличить'));
    expect(scroll.panel.style.touchAction).toBe('none');
    cleanup();

    const plain = setup();
    loadImage(plain.img, 1536, 2048);
    expect(plain.panel.style.touchAction).toBe('none');
  });

  it('панель стала меньше — «вписать» пересчитан, сдвиг снова в границах', () => {
    const { img, panel } = setup();
    loadImage(img, 1536, 2048);
    fireEvent.doubleClick(panel, { clientX: 400, clientY: 300 });
    fireEvent.pointerDown(panel, { pointerId: 1, clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(panel, { pointerId: 1, clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(panel, { pointerId: 1 });

    panelW = 400;
    panelH = 300;
    act(() => {
      for (const cb of roCallbacks) cb();
    });
    const g = geom(img);
    // Масштаб относительно «вписать» прежний (250%), сам кадр вдвое меньше.
    expect(percent()).toBe('250%');
    expect(g.h).toBeCloseTo(300 * 2.5);
    expect(g.x).toBeCloseTo((g.w - panelW) / 2);
    expect(g.y).toBeCloseTo((g.h - panelH) / 2);
  });

  it('onDisplayed — на load картинки, но не на ошибке', () => {
    const onDisplayed = vi.fn();
    const { img } = setup({ onDisplayed });
    fireEvent.error(img);
    expect(onDisplayed).not.toHaveBeenCalled();
    loadImage(img, 1536, 2048);
    expect(onDisplayed).toHaveBeenCalledWith('blob:scan');
  });

  it('миниатюру сменил оригинал на увеличенном и повёрнутом кадре — геометрия та же', () => {
    const { img, panel, rerender } = setup({ src: 'blob:thumb' });
    loadImage(img, 240, 320);
    fireEvent.click(screen.getByLabelText('Повернуть вправо'));
    fireEvent.doubleClick(panel, { clientX: 450, clientY: 320 });
    fireEvent.pointerDown(panel, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(panel, { pointerId: 1, clientX: 340, clientY: 280 });
    fireEvent.pointerUp(panel, { pointerId: 1 });
    const before = geom(img);

    rerender(<ZoomableImage src="blob:full" alt="Скан" />);
    const full = screen.getByAltText('Скан');
    expect(full.getAttribute('src')).toBe('blob:full');
    loadImage(full, 1536, 2048);
    const after = geom(full);
    expect(after.w).toBeCloseTo(before.w, 3);
    expect(after.h).toBeCloseTo(before.h, 3);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
    expect(after.r).toBe(90);
  });

  // Правый клик по снимку должен давать меню картинки браузера («Сохранить
  // картинку как…», «Копировать картинку»). С pointer-events: none у <img>
  // браузер видел клик по панели и показывал меню страницы.
  it('снимок принимает правый клик, заглушка — нет', () => {
    const { img, rerender } = setup();
    loadImage(img, 1536, 2048);
    expect(img.style.pointerEvents).toBe('auto');
    // contextmenu никто не гасит — браузер покажет своё меню.
    expect(fireEvent.contextMenu(img)).toBe(true);

    rerender(<ZoomableImage src="blob:scan" alt="Скан" dimmed />);
    expect(screen.getByAltText('Скан').style.pointerEvents).toBe('none');
  });

  it('жесты, начатые на самой картинке, работают как на панели; правая кнопка кадр не тащит', () => {
    const { img, panel } = setup();
    loadImage(img, 1536, 2048);

    // Двойной клик и колесо с картинки доходят до панели.
    fireEvent.doubleClick(img, { clientX: 400, clientY: 300 });
    expect(percent()).toBe('250%');
    const ev = wheel(img, -100, 400, 300);
    expect(ev.defaultPrevented).toBe(true);
    expect(percent()).not.toBe('250%');

    // Правая кнопка — это меню, не перетаскивание.
    const before = geom(img);
    fireEvent.pointerDown(img, { pointerId: 1, clientX: 400, clientY: 300, button: 2 });
    fireEvent.pointerMove(img, { pointerId: 1, clientX: 300, clientY: 200 });
    expect(geom(img)).toEqual(before);
    expect(panel.style.cursor).toBe('grab');
    fireEvent.pointerUp(img, { pointerId: 1, button: 2 });

    // Левая — перетаскивание, как с панели.
    fireEvent.pointerDown(img, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    expect(panel.style.cursor).toBe('grabbing');
    fireEvent.pointerMove(img, { pointerId: 1, clientX: 390, clientY: 295 });
    expect(geom(img).x).toBeCloseTo(before.x - 10);
    expect(geom(img).y).toBeCloseTo(before.y - 5);
    fireEvent.pointerUp(img, { pointerId: 1 });
    expect(panel.style.cursor).toBe('grab');

    // Нативное перетаскивание картинки как файла погашено.
    expect(fireEvent.dragStart(img)).toBe(false);
  });
});
