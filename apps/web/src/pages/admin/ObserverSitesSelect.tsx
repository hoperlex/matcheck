import { useEffect, useRef, useState } from 'react';
import { Select } from 'antd';
import type { Site } from '@matcheck/contracts';

/**
 * Выбор объектов наблюдателя (роль observer) — он видит данные только их.
 *
 * Изменение отдаётся наружу не на каждый клик, а когда список закрыт: каждое
 * сохранение завершает сессии наблюдателя, и серия PATCH по одному объекту
 * выкидывала бы его со входа на каждом щелчке. Снятие тега крестиком при
 * закрытом списке — законченное действие, оно уходит сразу.
 */
export function ObserverSitesSelect({
  value,
  sites,
  disabled,
  loading,
  onCommit,
}: {
  value: string[];
  sites: Site[];
  disabled?: boolean;
  loading?: boolean;
  onCommit: (siteIds: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[]>(value);
  const openRef = useRef(false);
  const key = [...value].sort().join(',');
  // Сервер прислал новый список (сохранение, правка в соседней вкладке) —
  // черновик догоняет его.
  useEffect(() => {
    setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const commit = (next: string[]) => {
    if ([...next].sort().join(',') === key) return;
    onCommit(next);
  };

  // Объект, который уже назначен, но стал неактивным, в справочнике активных
  // отсутствует — показываем его id, чтобы назначение не пропало молча.
  const known = new Set(sites.map((s) => s.id));
  const options = [
    ...sites.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}`, code: s.code })),
    ...draft
      .filter((id) => !known.has(id))
      .map((id) => ({ value: id, label: `неактивный объект ${id.slice(0, 8)}`, code: id.slice(0, 8) })),
  ];

  return (
    <Select<string[]>
      mode="multiple"
      value={draft}
      style={{ width: '100%' }}
      placeholder="Не назначены — не видит ничего"
      showSearch
      optionFilterProp="label"
      // В узкой колонке теги показывают только код объекта, полное название —
      // в выпадающем списке.
      optionLabelProp="code"
      loading={loading}
      disabled={disabled}
      aria-label="Объекты наблюдателя"
      onChange={(next) => {
        setDraft(next);
        if (!openRef.current) commit(next);
      }}
      onOpenChange={(open) => {
        openRef.current = open;
        if (!open) commit(draft);
      }}
      options={options}
    />
  );
}
