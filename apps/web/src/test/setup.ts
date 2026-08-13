/**
 * Общий setup наборов. В node-окружении (≈160 тестов чистой логики) файл —
 * no-op: `window` там нет вовсе. Всё ниже нужно только render-тестам, которые
 * поднимают jsdom директивой `// @vitest-environment jsdom`.
 *
 * Здесь не «чинится, чтобы позеленело»: каждый пункт — про то, чего в jsdom
 * нет по устройству, а не про поведение наших компонентов.
 */
if (typeof window !== 'undefined') {
  // antd Table и Select измеряют контейнер через ResizeObserver; в jsdom его
  // нет, и рендер таблицы падает ещё до первой проверки. Заглушка ничего не
  // наблюдает — размеры в тестах и так все нулевые.
  if (!('ResizeObserver' in window)) {
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }

  // matchMedia — responsive-хуки antd. jsdom его не реализует.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  // Галерея строит object-URL из blob'ов миниатюр. jsdom не реализует ни
  // createObjectURL, ни revoke — подставляем предсказуемый счётчик, чтобы
  // src плитки был непустым и cleanup не падал.
  if (!URL.createObjectURL) {
    let n = 0;
    URL.createObjectURL = () => `blob:test/${++n}`;
    URL.revokeObjectURL = () => {};
  }

  // jsdom не поддерживает второй аргумент getComputedStyle и на КАЖДЫЙ вызов
  // печатает «Not implemented: window.getComputedStyle(elt, pseudoElt)».
  // Зовёт его antd Wave — эффект нажатия читает ::after у кнопки. Псевдо-
  // элементов в jsdom нет в принципе, поэтому подавляем не диагностику, а
  // заведомо бессмысленный шум: стиль самого элемента возвращается как был.
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((elt: Element, pseudoElt?: string | null) =>
    pseudoElt ? computed(elt) : computed(elt, pseudoElt)) as typeof window.getComputedStyle;
}
