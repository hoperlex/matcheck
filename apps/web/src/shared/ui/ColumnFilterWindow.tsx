/**
 * Окно фильтра колонки — как у таблиц FOT («Управление кадрами»): заголовок,
 * поле поиска или дат, список значений с галочками, внизу «Сбросить» и
 * «Применить».
 *
 * Поведение одно для всех таблиц портала:
 * - набранное в окне (галочки, даты, текст) действует только после «Применить»;
 * - «Сбросить» сразу снимает фильтр этой колонки и закрывает окно;
 * - Esc и клик мимо окна закрывают его без изменений.
 *
 * Окно монтируется заново при каждом открытии и читает действующий фильтр в
 * этот момент. Иначе после сброса снаружи (чип, адрес) или после Esc оно
 * открывалось бы со старым черновиком: rc-trigger держит содержимое закрытого
 * попапа смонтированным и даже не перерисовывает его (`cache: !open`).
 */
import { useMemo, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Button, DatePicker, Input } from 'antd';
import type { ColumnType } from 'antd/es/table';
import type { FilterDropdownProps } from 'antd/es/table/interface';
import dayjs, { type Dayjs } from 'dayjs';
import { FunnelIcon } from './tableIcons';

export type FilterOption = { value: string; label: string; count?: number };

/** Сколько значений рисуем в списке разом; остальное — через поиск. */
const MAX_VISIBLE_OPTIONS = 300;

type WindowBase = {
  /** Подпись колонки — заголовок окна. */
  title: string;
  /** Пояснение под заголовком, если фильтр ищет не только то, что видно в колонке. */
  hint?: string;
  /** Закрыть без изменений (Esc). */
  onClose: () => void;
};

type ValuesWindowProps = WindowBase & {
  kind: 'values';
  options: readonly FilterOption[];
  selected: readonly string[];
  /** Выбор одного значения (радио) — для фильтров, которые сервер принимает единственным. */
  single?: boolean;
  showCounts?: boolean;
  loading?: boolean;
  /** null — снять фильтр. */
  onApply: (values: string[] | null) => void;
};

export type DateRange = { from: string | null; to: string | null };

type DatesWindowProps = WindowBase & {
  kind: 'dates';
  from: string | null;
  to: string | null;
  onApply: (range: DateRange | null) => void;
};

type TextWindowProps = WindowBase & {
  kind: 'text';
  value: string;
  placeholder?: string;
  /** Очистка ввода на лету (например, только цифры для id). */
  sanitize?: (raw: string) => string;
  onApply: (value: string | null) => void;
};

export type ColumnFilterWindowProps = ValuesWindowProps | DatesWindowProps | TextWindowProps;

export function ColumnFilterWindow(props: ColumnFilterWindowProps): ReactElement {
  // Esc ловим сами: фокус стоит в поле окна, и до обработчика Dropdown
  // нажатие может не дойти.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      props.onClose();
    }
  };
  return (
    <div
      className="mc-colfilter"
      role="dialog"
      aria-label={`Фильтр: ${props.title}`}
      onKeyDown={onKeyDown}
      // Клик внутри окна не должен долетать до заголовка колонки: там
      // висит переключение сортировки.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mc-colfilter-title">{props.title}</div>
      {props.hint && <div className="mc-colfilter-hint">{props.hint}</div>}
      {props.kind === 'values' ? (
        <ValuesBody {...props} />
      ) : props.kind === 'dates' ? (
        <DatesBody {...props} />
      ) : (
        <TextBody {...props} />
      )}
    </div>
  );
}

function Footer({
  onReset,
  onApply,
  applyDisabled,
}: {
  onReset: () => void;
  onApply: () => void;
  applyDisabled?: boolean;
}): ReactElement {
  return (
    <div className="mc-colfilter-footer">
      <Button size="small" onClick={onReset}>
        Сбросить
      </Button>
      <Button size="small" type="primary" onClick={onApply} disabled={applyDisabled}>
        Применить
      </Button>
    </div>
  );
}

function ValuesBody({
  options,
  selected: initial,
  single,
  showCounts,
  loading,
  onApply,
}: ValuesWindowProps): ReactElement {
  const [selected, setSelected] = useState<string[]>(() => [...initial]);
  const [search, setSearch] = useState('');

  // Выбранное значение, которого нет среди вариантов (справочник ещё грузится
  // или запись ушла в архив), всё равно показываем — иначе его нельзя снять.
  const allOptions = useMemo(() => {
    const known = new Set(options.map((o) => o.value));
    const missing = initial
      .filter((v) => !known.has(v))
      .map((v): FilterOption => ({ value: v, label: v, count: 0 }));
    return [...options, ...missing];
  }, [options, initial]);

  const query = search.trim().toLocaleLowerCase('ru');
  const matched = useMemo(
    () =>
      query
        ? allOptions.filter((o) => o.label.toLocaleLowerCase('ru').includes(query))
        : allOptions,
    [allOptions, query],
  );
  const shown = matched.slice(0, MAX_VISIBLE_OPTIONS);
  const selectedSet = new Set(selected);

  const toggle = (value: string): void => {
    if (single) {
      setSelected([value]);
      return;
    }
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  };

  return (
    <>
      <Input
        size="middle"
        type="search"
        placeholder="Найти значение…"
        aria-label="Найти значение"
        allowClear
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {!single && (
        <div className="mc-colfilter-bulk">
          <button
            type="button"
            className="mc-colfilter-link"
            disabled={shown.length === 0}
            onClick={() =>
              setSelected((prev) => [...new Set([...prev, ...shown.map((o) => o.value)])])
            }
          >
            Выбрать показанные
          </button>
          <button
            type="button"
            className="mc-colfilter-link"
            disabled={selected.length === 0}
            onClick={() => setSelected([])}
          >
            Снять всё
          </button>
        </div>
      )}
      <div className="mc-colfilter-list" role="group" aria-label="Значения">
        {loading ? (
          <div className="mc-colfilter-hint">Загрузка…</div>
        ) : shown.length === 0 ? (
          <div className="mc-colfilter-hint">Ничего не найдено</div>
        ) : (
          shown.map((o) => (
            <label key={o.value} className="mc-colfilter-option">
              <input
                type={single ? 'radio' : 'checkbox'}
                checked={selectedSet.has(o.value)}
                onChange={() => toggle(o.value)}
              />
              <span className="mc-colfilter-label">{o.label}</span>
              {showCounts && <span className="mc-colfilter-count">{o.count ?? 0}</span>}
            </label>
          ))
        )}
        {matched.length > MAX_VISIBLE_OPTIONS && (
          <div className="mc-colfilter-hint">
            Показаны первые {MAX_VISIBLE_OPTIONS} — уточните поиском
          </div>
        )}
      </div>
      {!single && selected.length > 0 && (
        <div className="mc-colfilter-hint">Выбрано: {selected.length}</div>
      )}
      <Footer
        onReset={() => onApply(null)}
        onApply={() => onApply(selected.length > 0 ? selected : null)}
      />
    </>
  );
}

function toDay(iso: string | null): Dayjs | null {
  if (!iso) return null;
  const d = dayjs(iso);
  return d.isValid() ? d : null;
}

function DatesBody({ from: initialFrom, to: initialTo, onApply }: DatesWindowProps): ReactElement {
  const [from, setFrom] = useState<Dayjs | null>(() => toDay(initialFrom));
  const [to, setTo] = useState<Dayjs | null>(() => toDay(initialTo));
  const inverted = !!from && !!to && from.isAfter(to, 'day');

  const apply = (): void => {
    if (!from && !to) {
      onApply(null);
      return;
    }
    onApply({
      from: from ? from.format('YYYY-MM-DD') : null,
      to: to ? to.format('YYYY-MM-DD') : null,
    });
  };

  return (
    <>
      <div className="mc-colfilter-dates">
        <label className="mc-colfilter-field">
          <span>С</span>
          <DatePicker
            value={from}
            onChange={setFrom}
            placeholder="С даты"
            format="DD.MM.YYYY"
            allowClear
            style={{ width: '100%' }}
          />
        </label>
        <label className="mc-colfilter-field">
          <span>По</span>
          <DatePicker
            value={to}
            onChange={setTo}
            placeholder="По дату"
            format="DD.MM.YYYY"
            allowClear
            style={{ width: '100%' }}
          />
        </label>
      </div>
      {inverted && (
        <div className="mc-colfilter-error" role="alert">
          Дата «с» позже даты «по»
        </div>
      )}
      <Footer onReset={() => onApply(null)} onApply={apply} applyDisabled={inverted} />
    </>
  );
}

function TextBody({
  value: initial,
  placeholder,
  sanitize,
  onApply,
}: TextWindowProps): ReactElement {
  const [value, setValue] = useState(initial);
  const apply = (): void => {
    const v = value.trim();
    onApply(v ? v : null);
  };
  return (
    <>
      <Input
        size="middle"
        placeholder={placeholder ?? 'Содержит…'}
        aria-label={placeholder ?? 'Содержит'}
        allowClear
        autoFocus
        value={value}
        onChange={(e) => setValue(sanitize ? sanitize(e.target.value) : e.target.value)}
        onPressEnter={apply}
      />
      <Footer onReset={() => onApply(null)} onApply={apply} />
    </>
  );
}

// ─── Подключение к antd Table ───────────────────────────────────────────────

/**
 * Окно открывается под воронкой по центру, как в FOT. destroyOnHidden —
 * чтобы каждое открытие начиналось с действующего фильтра (см. шапку файла).
 */
const FILTER_DROPDOWN_PROPS: ColumnType<unknown>['filterDropdownProps'] = {
  placement: 'bottom',
  rootClassName: 'mc-colfilter-root',
  destroyOnHidden: true,
};

export type AntdColumnFilterConfig =
  | {
      kind: 'values';
      title: string;
      hint?: string;
      options: readonly FilterOption[] | (() => readonly FilterOption[]);
      single?: boolean;
      showCounts?: boolean;
    }
  | { kind: 'dates'; title: string; hint?: string }
  | { kind: 'text'; title: string; hint?: string; placeholder?: string };

/** Ключ antd-фильтра дат: `from|to`, любая из границ может быть пустой. */
export function dateRangeKey(range: DateRange): string | null {
  return range.from || range.to ? `${range.from ?? ''}|${range.to ?? ''}` : null;
}

function AntdFilterContent({
  cfg,
  p,
}: {
  cfg: AntdColumnFilterConfig;
  p: FilterDropdownProps;
}): ReactElement | null {
  // Закрытое окно ничего не рисует; само содержимое при закрытии уничтожается
  // (destroyOnHidden), и следующее открытие начинается с действующего фильтра.
  if (!p.visible) return null;

  // Применение — ровно один вызов Table.onChange: confirm после
  // setSelectedKeys (antd хранит ключи синхронно), сброс — clearFilters с
  // confirm. Страница видит одно изменение, а не два подряд.
  const applyKeys = (keys: string[] | null): void => {
    if (!keys || keys.length === 0) {
      p.clearFilters?.({ confirm: true, closeDropdown: true });
      return;
    }
    p.setSelectedKeys(keys);
    p.confirm({ closeDropdown: true });
  };
  const current = p.selectedKeys.map(String);

  if (cfg.kind === 'values') {
    const options = typeof cfg.options === 'function' ? cfg.options() : cfg.options;
    return (
      <ColumnFilterWindow
        kind="values"
        title={cfg.title}
        hint={cfg.hint}
        options={options}
        selected={current}
        single={cfg.single}
        showCounts={cfg.showCounts}
        onClose={p.close}
        onApply={applyKeys}
      />
    );
  }
  if (cfg.kind === 'dates') {
    const [from, to] = (current[0] ?? '').split('|');
    return (
      <ColumnFilterWindow
        kind="dates"
        title={cfg.title}
        hint={cfg.hint}
        from={from || null}
        to={to || null}
        onClose={p.close}
        onApply={(range) => {
          const key = range ? dateRangeKey(range) : null;
          applyKeys(key ? [key] : null);
        }}
      />
    );
  }
  return (
    <ColumnFilterWindow
      kind="text"
      title={cfg.title}
      hint={cfg.hint}
      value={current[0] ?? ''}
      placeholder={cfg.placeholder}
      onClose={p.close}
      onApply={(v) => applyKeys(v ? [v] : null)}
    />
  );
}

/**
 * Фильтр колонки через состояние antd: значение живёт в Table (или в
 * `filteredValue`, если страница держит его сама) и приходит в `onChange`.
 */
export function antdColumnFilter<T>(
  cfg: AntdColumnFilterConfig,
): Pick<ColumnType<T>, 'filterDropdown' | 'filterIcon' | 'filterDropdownProps'> {
  return {
    filterDropdown: (p) => <AntdFilterContent cfg={cfg} p={p} />,
    filterIcon: () => <FunnelIcon />,
    filterDropdownProps: FILTER_DROPDOWN_PROPS,
  };
}

// ─── Внешнее состояние (серверные списки) ──────────────────────────────────

export type ExternalColumnFilterConfig =
  | {
      kind: 'values';
      title: string;
      hint?: string;
      options: readonly FilterOption[];
      value: readonly string[];
      /** Пустой массив — снять фильтр. */
      onApply: (values: string[]) => void;
      single?: boolean;
      loading?: boolean;
    }
  | {
      kind: 'dates';
      title: string;
      hint?: string;
      from: string | null;
      to: string | null;
      onApply: (range: DateRange) => void;
    }
  | {
      kind: 'text';
      title: string;
      hint?: string;
      value: string;
      placeholder?: string;
      sanitize?: (raw: string) => string;
      /** Пустая строка — снять фильтр. */
      onApply: (value: string) => void;
    };

function ExternalFilterContent({
  cfg,
  p,
}: {
  cfg: ExternalColumnFilterConfig;
  p: FilterDropdownProps;
}): ReactElement | null {
  if (!p.visible) return null;
  // Путь применения ровно один: апдейтер страницы (тот же, что у панели над
  // таблицей), затем закрыть окно. confirm/clearFilters здесь не зовём — они
  // вызвали бы ещё и Table.onChange, а страница пишет адрес от одного снимка
  // параметров: второе обновление за клик затёрло бы первое.
  const done = (): void => p.close();
  if (cfg.kind === 'values') {
    return (
      <ColumnFilterWindow
        kind="values"
        title={cfg.title}
        hint={cfg.hint}
        options={cfg.options}
        selected={cfg.value}
        single={cfg.single}
        loading={cfg.loading}
        onClose={done}
        onApply={(values) => {
          cfg.onApply(values ?? []);
          done();
        }}
      />
    );
  }
  if (cfg.kind === 'dates') {
    return (
      <ColumnFilterWindow
        kind="dates"
        title={cfg.title}
        hint={cfg.hint}
        from={cfg.from}
        to={cfg.to}
        onClose={done}
        onApply={(range) => {
          cfg.onApply(range ?? { from: null, to: null });
          done();
        }}
      />
    );
  }
  return (
    <ColumnFilterWindow
      kind="text"
      title={cfg.title}
      hint={cfg.hint}
      value={cfg.value}
      placeholder={cfg.placeholder}
      sanitize={cfg.sanitize}
      onClose={done}
      onApply={(value) => {
        cfg.onApply(value ?? '');
        done();
      }}
    />
  );
}

/**
 * Фильтр колонки серверного списка, у которого есть поле в панели над таблицей:
 * значение живёт там же, где у панели (адрес или state страницы), и меняется
 * тем же апдейтером — воронка и панель показывают одно и то же. Через
 * Table.onChange изменение не идёт.
 */
export function externalColumnFilter<T>(
  cfg: ExternalColumnFilterConfig,
): Pick<ColumnType<T>, 'filterDropdown' | 'filterIcon' | 'filterDropdownProps' | 'filteredValue'> {
  const filteredValue =
    cfg.kind === 'values'
      ? cfg.value.length > 0
        ? [...cfg.value]
        : null
      : cfg.kind === 'dates'
        ? (() => {
            const key = dateRangeKey({ from: cfg.from, to: cfg.to });
            return key ? [key] : null;
          })()
        : cfg.value
          ? [cfg.value]
          : null;
  return {
    filterDropdown: (p) => <ExternalFilterContent cfg={cfg} p={p} />,
    filterIcon: () => <FunnelIcon />,
    filterDropdownProps: FILTER_DROPDOWN_PROPS,
    filteredValue,
  };
}
