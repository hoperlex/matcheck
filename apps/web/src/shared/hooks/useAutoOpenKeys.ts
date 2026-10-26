import { useEffect, useRef, useState } from 'react';

/**
 * Раскрытые панели Collapse с «раскрыть один раз».
 *
 * Ключ из `autoOpen` раскрывается, когда впервые появляется в списке, — дальше
 * панелью управляет человек: свёрнутая им не раскрывается снова ни на опросе
 * карточки, ни на перерисовке. Новый ключ (например, только что привязанная
 * УПД) раскроется сам.
 *
 * Сравнение по содержимому, а не по ссылке: список строится заново на каждом
 * рендере.
 */
export function useAutoOpenKeys(autoOpen: readonly string[] | undefined) {
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const seen = useRef(new Set<string>());
  const signature = autoOpen?.join('\u0000') ?? '';

  useEffect(() => {
    const keys = signature ? signature.split('\u0000') : [];
    const fresh = keys.filter((key) => !seen.current.has(key));
    if (fresh.length === 0) return;
    for (const key of fresh) seen.current.add(key);
    setOpenKeys((prev) => [...prev, ...fresh.filter((key) => !prev.includes(key))]);
  }, [signature]);

  return [openKeys, setOpenKeys] as const;
}
