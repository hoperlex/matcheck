import { useMemo, useState } from 'react';
import { Select, Spin, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResponsiblePerson } from '@matcheck/contracts';
import { api } from '../services/api';

type ListResp = { items: ResponsiblePerson[]; total: number };

/**
 * Combobox МОЛ (материально-ответственное лицо): выбор из справочника +
 * «+ Создать «ФИО»». Сервер делает дедуп по lower(full_name) (POST
 * /responsible-persons). Aliases у МОЛ нет (ФИО уникально, короткие
 * формы не используем).
 */
export function ResponsiblePersonSelect({
  value,
  onChange,
  disabled,
  placeholder = 'Выберите МОЛ',
  activeOnly = true,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  activeOnly?: boolean;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['responsible-persons', activeOnly ? 'active' : 'all'],
    queryFn: () =>
      api.get<ListResp>(
        `/responsible-persons?limit=500${activeOnly ? '&activeOnly=true' : ''}`,
      ),
  });
  const items = list.data?.items ?? [];

  const create = useMutation<ResponsiblePerson, Error, string>({
    mutationFn: (fullName) =>
      api.post<ResponsiblePerson>('/responsible-persons', {
        fullName,
        position: null,
        phone: null,
      }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['responsible-persons'] });
      onChange(created.id);
      setSearch('');
    },
    onError: (err) => message.error(err.message),
  });

  const trimmed = search.trim();
  const trimmedLower = trimmed.toLowerCase();
  const hasExact = useMemo(
    () => items.some((p) => p.fullName.trim().toLowerCase() === trimmedLower),
    [items, trimmedLower],
  );

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
      optionFilterProp="label"
      options={items.map((p) => ({ value: p.id, label: p.fullName }))}
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
