import { useMemo, useState } from 'react';
import { Select, Spin, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Counterparty } from '@matcheck/contracts';
import { isPlaceholderInn } from '@matcheck/contracts';
import { api } from '../../services/api';

type CounterpartyListResponse = { items: Counterparty[]; total: number };

/**
 * Combobox подрядчика: выбор из справочника + возможность создать нового
 * «на лету» — если в поиске нет точного совпадения, в выпадашке появляется
 * пункт «+ Создать «X»». При клике POST /counterparties (сервер делает
 * дедуп по lower(name) / aliases / ИНН), полученный id выбирается.
 *
 * ИНН-placeholder («0000…») в подписи скрывается — пользователь видит
 * только название для контрагентов, созданных без ИНН.
 */
export function ContractorSelect({
  value,
  onChange,
  disabled,
  placeholder = 'Выберите подрядчика',
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['counterparties', { role: 'contractor' }],
    queryFn: () =>
      api.get<CounterpartyListResponse>('/counterparties?role=contractor&limit=500'),
  });
  const items = list.data?.items ?? [];

  const create = useMutation<Counterparty, Error, string>({
    mutationFn: (name) =>
      api.post<Counterparty>('/counterparties', { name, isContractor: true }),
    onSuccess: (created) => {
      // Сервер мог вернуть существующего (дедуп) — в любом случае
      // инвалидируем список и выбираем результат.
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
      onChange(created.id);
      setSearch('');
    },
    onError: (err) => message.error(err.message),
  });

  const trimmed = search.trim();
  const trimmedLower = trimmed.toLowerCase();
  const hasExact = useMemo(
    () =>
      items.some(
        (c) =>
          c.name.trim().toLowerCase() === trimmedLower ||
          (c.aliases ?? []).some((a) => a.trim().toLowerCase() === trimmedLower),
      ),
    [items, trimmedLower],
  );

  const options = items.map((c) => ({
    value: c.id,
    label: c.name + (c.inn && !isPlaceholderInn(c.inn) ? ` (ИНН ${c.inn})` : ''),
    searchKey: `${c.name} ${c.inn ?? ''} ${(c.aliases ?? []).join(' ')}`.toLowerCase(),
  }));

  return (
    <Select
      showSearch
      allowClear
      placeholder={placeholder}
      value={value ?? undefined}
      onChange={(v) => onChange(v ?? null)}
      onSearch={setSearch}
      loading={list.isLoading}
      disabled={disabled || create.isPending}
      style={{ width: '100%' }}
      filterOption={(input, opt) =>
        // searchKey покрывает name + inn + aliases.
        String((opt as { searchKey?: string })?.searchKey ?? '').includes(
          input.toLowerCase(),
        )
      }
      options={options}
      // dropdownRender: внизу — пункт «+ Создать «X»», если введён текст
      // и нет точного совпадения. Создание идёт через мутацию выше;
      // ContractorSelect сам выбирает созданный/найденный id.
      notFoundContent={
        list.isLoading ? <Spin size="small" /> : trimmed ? null : 'Ничего не найдено'
      }
      dropdownRender={(menu) => (
        <>
          {menu}
          {trimmed && !hasExact && (
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!create.isPending) create.mutate(trimmed);
              }}
              style={{
                padding: '8px 12px',
                cursor: create.isPending ? 'wait' : 'pointer',
                borderTop: '1px solid #f0f0f0',
                color: '#1677ff',
                fontWeight: 500,
              }}
            >
              <PlusOutlined style={{ marginInlineEnd: 6 }} />
              Создать «{trimmed}»
              {create.isPending && <Spin size="small" style={{ marginInlineStart: 8 }} />}
            </div>
          )}
        </>
      )}
    />
  );
}
