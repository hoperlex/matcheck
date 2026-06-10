import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// Высота родительских sticky-шапок над текущим блоком. Используется для
// каскада: вложенный StickyPageHeader прилипает не к top:0, а под уже
// прилипшие шапки выше. ResponsiveTable читает суммарную высоту через
// useStickyHeaderHeight и прокидывает её в Table.sticky.offsetHeader.
const StickyHeaderHeightContext = createContext(0);

export function useStickyHeaderHeight(): number {
  return useContext(StickyHeaderHeightContext);
}

export function StickyPageHeader({
  header,
  children,
}: {
  header: ReactNode;
  children: ReactNode;
}) {
  const parentHeight = useContext(StickyHeaderHeightContext);
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  // useLayoutEffect — измерение шапки и установка height ДО первого paint:
  // иначе ResponsiveTable получает offsetHeader=0 на первом рендере и шапка
  // таблицы прилипает к top:0, а после следующего рендера прыгает на N px
  // вниз — видимый «люфт» при первом скролле.
  //
  // offsetHeight даёт целое число пикселей — без суб-пиксельных колебаний
  // getBoundingClientRect (вызывавших люфт 1-2px при скролле). setState
  // внутри useLayoutEffect React 18 применяет синхронно до paint, поэтому
  // flushSync здесь не нужен и противопоказан (warning в console).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <StickyHeaderHeightContext.Provider value={parentHeight + height}>
      <div
        ref={ref}
        style={{
          position: 'sticky',
          top: parentHeight,
          background: '#f5f5f5',
          zIndex: 10 - Math.min(parentHeight > 0 ? 1 : 0, 9),
          // Sticky-блок занимает ширину Content (у которого padding 24).
          // Чтобы фон закрывал контент под собой по всей ширине, расширяем
          // блок отрицательными горизонтальными margin'ами и компенсируем
          // их собственным padding'ом. Вертикально — лёгкий paddingBottom
          // для воздуха перед таблицей; верхний padding нужен только для
          // самого корневого блока (parentHeight === 0), иначе примыкаем
          // вплотную к родительскому sticky.
          marginInlineStart: -24,
          marginInlineEnd: -24,
          paddingInlineStart: 24,
          paddingInlineEnd: 24,
          paddingBottom: 8,
          // Корневой блок: компенсируем верхний padding Content (12px)
          // отрицательным margin (-12px) и даём свой небольшой paddingTop,
          // чтобы заголовок прижимался ближе к верхней границе окна — но
          // не наезжал на неё. Раньше было -24/16, давало ~16px воздуха
          // сверху; сейчас -12/6 даёт ~6px — таблица получает +14px места.
          ...(parentHeight === 0
            ? { marginTop: -12, paddingTop: 6, marginBottom: 6 }
            : { paddingTop: 8, marginBottom: 6 }),
        }}
      >
        {header}
      </div>
      {children}
    </StickyHeaderHeightContext.Provider>
  );
}
