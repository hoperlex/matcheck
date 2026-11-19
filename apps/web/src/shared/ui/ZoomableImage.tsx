import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SyntheticEvent,
} from 'react';
import { Button, Tooltip } from 'antd';
import {
  CompressOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import {
  clampOffset,
  FIT_VIEW,
  fitScale,
  MAX_Z,
  MIN_Z,
  scaleAbout,
  wheelFactor,
  zoomAt,
  type Point,
  type Size,
  type View,
} from './zoomMath';

/** Шаг кнопок +/−. */
const BUTTON_STEP = 1.5;
/** Куда приближает двойной клик из «вписать». */
const DOUBLE_CLICK_Z = 2.5;
const HINT = 'Колесо — масштаб, перетаскивание — сдвиг, двойной клик — приблизить';

type Gesture =
  | { kind: 'drag'; start: Point; view: View }
  | { kind: 'pinch'; dist0: number; mid0: Point; view: View };

/**
 * Просмотр скана прямо в панели: колесо масштабирует в точке курсора без
 * предварительного клика, увеличенный кадр двигается мышью или пальцем,
 * кнопки поворачивают на 90°. Пришёл на смену приёму «antd Image + маска
 * „Открыть для зума“», где ради зума открывалось второе окно поверх первого.
 *
 * Геометрия — в zoomMath.ts (там и почему масштаб хранится относительно
 * «вписать»). Здесь — события и разметка.
 *
 * Жесты на pointer events. touch-action браузер фиксирует в момент касания и
 * посреди жеста не перечитывает, поэтому:
 *   - без touchScroll (панель не прокручивается) — всегда `none`, все касания
 *     наши;
 *   - с touchScroll (окно стопкой на телефоне) — при «вписать» `pan-y`, чтобы
 *     свайп по фото листал окно, иначе `none`. Щипок, начатый при «вписать»,
 *     браузер вправе забрать себе — придёт pointercancel, кадр останется на
 *     месте, а увеличить можно кнопкой «+».
 * pointerup, pointercancel и lostpointercapture снимают палец одинаково;
 * переход «два пальца → один» продолжает перетаскивание от текущих точки и
 * масштаба, без скачка.
 */
export function ZoomableImage({
  src,
  alt,
  dimmed = false,
  initialRotation = 0,
  onRotationChange,
  onDisplayed,
  touchScroll = false,
}: {
  src: string;
  alt: string;
  /**
   * Кадр — заглушка (например, миниатюра, пока качается оригинал): приглушён,
   * и правый клик по нему не даёт меню картинки, чтобы «Сохранить картинку
   * как…» не сохранило мутную миниатюру вместо снимка.
   */
  dimmed?: boolean;
  initialRotation?: number;
  onRotationChange?: (rotation: number) => void;
  /** Картинка с этим src реально загрузилась и нарисована (не вызывается на ошибке). */
  onDisplayed?: (src: string) => void;
  /** Окно прокручивается целиком — при «вписать» свайп по фото листает его. */
  touchScroll?: boolean;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Size | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [rotation, setRotation] = useState(initialRotation);
  const [view, setView] = useState<View>(FIT_VIEW);
  const [animate, setAnimate] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Колесо висит нативным listener'ом, жесты растянуты на много событий —
  // актуальные геометрию и вид читаем через ref, а не из замыкания.
  const viewRef = useRef<View>(view);
  const geomRef = useRef({ container, natural, rotation });
  geomRef.current = { container, natural, rotation };

  const apply = useCallback((next: View, withAnimation: boolean) => {
    viewRef.current = next;
    setAnimate(withAnimation);
    setView(next);
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setContainer((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Панель сменила размер, пришёл оригинал вместо миниатюры, кадр повернули —
  // масштаб остаётся, сдвиг заново упирается в границы.
  useEffect(() => {
    if (!container || !natural) return;
    const v = viewRef.current;
    const next = clampOffset(v, container, natural, rotation);
    if (next.x !== v.x || next.y !== v.y || next.z !== v.z) apply(next, false);
  }, [container, natural, rotation, apply]);

  // Колесо — нативным listener'ом: React вешает wheel пассивным, и
  // preventDefault из onWheel прокрутку не отменит.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { container: c, natural: n, rotation: r } = geomRef.current;
      if (!c || !n || fitScale(c, n, r) === 0) return;
      e.preventDefault();
      const v = viewRef.current;
      apply(
        zoomAt(v, v.z * wheelFactor(e, c.h), toLocal(el, c, e.clientX, e.clientY), c, n, r),
        false,
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [apply]);

  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);

  // Новая точка отсчёта жеста — при каждом изменении числа пальцев. Поэтому
  // ни второй палец, ни отпущенный палец кадр не дёргают.
  const restartGesture = () => {
    const pts = [...pointers.current.values()];
    const v = viewRef.current;
    if (pts.length === 0) {
      gesture.current = null;
      setDragging(false);
      return;
    }
    const [a, b] = pts;
    gesture.current =
      a && b
        ? { kind: 'pinch', dist0: Math.max(1, distance(a, b)), mid0: midpoint(a, b), view: v }
        : { kind: 'drag', start: a!, view: v };
    setDragging(true);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pointers.current.size >= 2) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Захват не обязателен: без него жест просто кончится на краю панели.
    }
    restartGesture();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const { container: c, natural: n, rotation: r } = geomRef.current;
    const el = containerRef.current;
    if (!g || !c || !n || !el) return;
    if (g.kind === 'drag') {
      const p = pointers.current.get(e.pointerId)!;
      apply(
        clampOffset(
          { z: g.view.z, x: g.view.x + p.x - g.start.x, y: g.view.y + p.y - g.start.y },
          c,
          n,
          r,
        ),
        false,
      );
      return;
    }
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    const mid = midpoint(a, b);
    const scaled = scaleAbout(
      g.view,
      g.view.z * (distance(a, b) / g.dist0),
      toLocal(el, c, g.mid0.x, g.mid0.y),
    );
    apply(
      clampOffset(
        { z: scaled.z, x: scaled.x + mid.x - g.mid0.x, y: scaled.y + mid.y - g.mid0.y },
        c,
        n,
        r,
      ),
      false,
    );
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    // lostpointercapture приходит и после pointerup — второй раз палец уже снят.
    if (!pointers.current.delete(e.pointerId)) return;
    restartGesture();
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const { container: c, natural: n, rotation: r } = geomRef.current;
    if (!c || !n || fitScale(c, n, r) === 0) return;
    const v = viewRef.current;
    apply(
      v.z > MIN_Z
        ? FIT_VIEW
        : zoomAt(v, DOUBLE_CLICK_Z, toLocal(e.currentTarget, c, e.clientX, e.clientY), c, n, r),
      true,
    );
  };

  const zoomBy = (factor: number) => {
    const { container: c, natural: n, rotation: r } = geomRef.current;
    if (!c || !n) return;
    const v = viewRef.current;
    // Точка (0,0) — центр панели: кнопки приближают то, что посередине.
    apply(zoomAt(v, v.z * factor, { x: 0, y: 0 }, c, n, r), true);
  };

  const rotateBy = (delta: number) => {
    // Угол копится (−90, 450 …): иначе переход 270° → 0° анимация провернула
    // бы назад на три четверти круга.
    const next = rotation + delta;
    setRotation(next);
    onRotationChange?.(next);
    apply(FIT_VIEW, true);
  };

  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNatural((prev) =>
        prev && prev.w === img.naturalWidth && prev.h === img.naturalHeight
          ? prev
          : { w: img.naturalWidth, h: img.naturalHeight },
      );
    }
    onDisplayed?.(img.getAttribute('src') ?? src);
  };

  const fit = container && natural ? fitScale(container, natural, rotation) : 0;
  const scale = fit * view.z;
  // Размер задаём самому <img> (а не scale в transform): тогда браузер
  // пересэмплирует скан под экранный размер как обычную картинку, и мелкий
  // текст при «вписать» не рябит. transform — только сдвиг и поворот.
  const imgStyle: CSSProperties =
    fit > 0 && natural
      ? {
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: natural.w * scale,
          height: natural.h * scale,
          maxWidth: 'none',
          maxHeight: 'none',
          transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) rotate(${rotation}deg)`,
          transition: animate
            ? 'transform 0.2s ease, width 0.2s ease, height 0.2s ease, opacity 0.2s'
            : 'opacity 0.2s',
        }
      : {
          // Пока размеры неизвестны — просто вписанный кадр, как раньше.
          position: 'absolute',
          inset: 0,
          margin: 'auto',
          maxWidth: '100%',
          maxHeight: '100%',
          transition: 'opacity 0.2s',
        };

  const zoomed = view.z > MIN_Z;

  return (
    <div
      ref={containerRef}
      data-zoomable-image=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onDoubleClick={onDoubleClick}
      // Страховка к draggable={false}: Firefox и Safari иначе могут потащить
      // картинку как файл и сорвать перетаскивание кадра.
      onDragStart={(e) => e.preventDefault()}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        userSelect: 'none',
        touchAction: touchScroll && !zoomed ? 'pan-y' : 'none',
        cursor: zoomed ? (dragging ? 'grabbing' : 'grab') : 'default',
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={onLoad}
        style={{
          ...imgStyle,
          opacity: dimmed ? 0.5 : 1,
          // Картинка принимает указатель, чтобы правый клик давал меню
          // картинки («Сохранить картинку как…», «Копировать картинку»), а не
          // меню страницы. Жесты от этого не меняются: события с <img>
          // всплывают в обработчики панели, захват указателя ставится на
          // панель (currentTarget), правую кнопку onPointerDown пропускает.
          // У заглушки меню закрыто — см. проп dimmed.
          pointerEvents: dimmed ? 'none' : 'auto',
          userSelect: 'none',
        }}
      />
      <div
        // Нажатие на кнопку не должно начинать перетаскивание кадра.
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 12,
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '2px 6px',
          borderRadius: 20,
          background: 'rgba(0, 0, 0, 0.55)',
          zIndex: 2,
        }}
      >
        <ToolButton
          label="Повернуть влево"
          icon={<RotateLeftOutlined />}
          onClick={() => rotateBy(-90)}
        />
        <ToolButton
          label="Повернуть вправо"
          icon={<RotateRightOutlined />}
          onClick={() => rotateBy(90)}
        />
        <ToolButton
          label="Уменьшить"
          icon={<ZoomOutOutlined />}
          disabled={fit === 0 || !zoomed}
          onClick={() => zoomBy(1 / BUTTON_STEP)}
        />
        <Tooltip title={HINT}>
          <span
            aria-label="Масштаб"
            style={{ color: '#fff', fontSize: 12, minWidth: 44, textAlign: 'center' }}
          >
            {Math.round(view.z * 100)}%
          </span>
        </Tooltip>
        <ToolButton
          label="Увеличить"
          icon={<ZoomInOutlined />}
          disabled={fit === 0 || view.z >= MAX_Z}
          onClick={() => zoomBy(BUTTON_STEP)}
        />
        <ToolButton
          label="Вписать"
          icon={<CompressOutlined />}
          disabled={!zoomed}
          onClick={() => apply(FIT_VIEW, true)}
        />
      </div>
    </div>
  );
}

function ToolButton({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Tooltip title={label}>
      <Button
        type="text"
        size="small"
        aria-label={label}
        icon={icon}
        disabled={disabled}
        onClick={onClick}
        style={{ color: disabled ? 'rgba(255, 255, 255, 0.35)' : '#fff' }}
      />
    </Tooltip>
  );
}

/** Точка экрана → координаты от центра панели (как их ждёт zoomMath). */
function toLocal(el: HTMLElement, c: Size, clientX: number, clientY: number): Point {
  const rect = el.getBoundingClientRect();
  return { x: clientX - rect.left - c.w / 2, y: clientY - rect.top - c.h / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
