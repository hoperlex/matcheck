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
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setHeight(Math.ceil(el.getBoundingClientRect().height));
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
          paddingBottom: 12,
          ...(parentHeight === 0
            ? { marginTop: -24, paddingTop: 16, marginBottom: 8 }
            : { paddingTop: 12, marginBottom: 8 }),
        }}
      >
        {header}
      </div>
      {children}
    </StickyHeaderHeightContext.Provider>
  );
}
