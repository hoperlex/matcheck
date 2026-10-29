import { useMemo, useState } from 'react';
import { Button, Input, Select, Space, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { CustomerCounterparty } from '@matcheck/contracts';
import { api } from '../../services/api';
import { normalizeInn } from '../../shared/utils/inn';
import { shortenCounterpartyName } from '../../shared/utils/companyShortName';
import type { DocumentPartyValue } from './sourceDocumentPatchBody';

type CcListResp = { items: CustomerCounterparty[]; total: number };

const CURRENT = '__current__';
const MANUAL = '__manual__';

type Option = {
  value: string;
  label: string;
  kind: 'manual' | 'directory';
  searchKey: string;
};

/**
 * Сторона документа — покупатель или грузополучатель — в карточке.
 *
 * Источник — справочник заказчика (Справочники → Контрагенты), тот же запрос и
 * тот же ключ кэша, что у CustomerCounterpartySelect. Но выбор здесь НЕ
 * резолвится в операционного контрагента через /counterparties/from-directory:
 * Мониторингу этот маршрут закрыт, а сам он ставит контрагенту признак
 * подрядчика, что для стороны документа неверно. Наружу уходят имя и ИНН, связь
 * со справочником сервер строит сам.
 *
 * Справочник покрывает примерно три четверти сторон из УПД, поэтому есть
 * «Ввести вручную»: набранный в поиске текст становится названием, а ИНН
 * вводится отдельным полем.
 */
export function DocumentPartySelect({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: DocumentPartyValue | null;
  onChange: (value: DocumentPartyValue | null) => void;
  placeholder: string;
  ariaLabel: string;
}): JSX.Element {
  const list = useQuery({
    queryKey: ['customer-counterparties', 'directory'],
    queryFn: () => api.get<CcListResp>('/customer-counterparties?limit=5000'),
    // ~150 записей — справочник, меняется редко.
    staleTime: 5 * 60 * 1000,
  });
  const [search, setSearch] = useState('');
  const typed = search.trim();

  const directory = list.data?.items;
  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    if (typed) {
      out.push({
        value: MANUAL,
        label: `Ввести вручную: «${typed}»`,
        kind: 'manual',
        searchKey: '',
      });
    }
    for (const c of directory ?? []) {
      out.push({
        value: c.id,
        label: c.inn ? `${c.name} (ИНН ${c.inn})` : c.name,
        kind: 'directory',
        searchKey: `${c.name} ${c.inn ?? ''} ${(c.aliases ?? []).join(' ')}`.toLowerCase(),
      });
    }
    return out;
  }, [typed, directory]);

  // У распознанной или введённой вручную стороны записи в справочнике нет,
  // поэтому выбранное значение — служебный CURRENT, а подпись рисует
  // labelRender. Отдельной опцией его больше не держим: при раскрытии без
  // поиска она стояла первой рядом с той же организацией из справочника.
  const currentLabel = value
    ? value.inn
      ? `${shortenCounterpartyName(value.name)} (ИНН ${value.inn})`
      : shortenCounterpartyName(value.name)
    : null;

  const innInvalid = value?.source === 'manual' && !!value.inn && normalizeInn(value.inn) == null;

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Select<string, Option>
        aria-label={ariaLabel}
        showSearch
        allowClear
        value={value ? CURRENT : undefined}
        placeholder={placeholder}
        searchValue={search}
        onSearch={setSearch}
        loading={list.isLoading}
        options={options}
        labelRender={(item) =>
          item.value === CURRENT ? (currentLabel ?? '') : (item.label ?? item.value)
        }
        filterOption={(input, opt) => {
          if (!opt) return false;
          // Ручной ввод всегда виден, пока есть текст.
          if (opt.kind === 'manual') return true;
          return opt.searchKey.includes(input.trim().toLowerCase());
        }}
        onSelect={(picked) => {
          setSearch('');
          if (picked === MANUAL) {
            onChange({ name: typed, inn: null, source: 'manual' });
            return;
          }
          const item = directory?.find((c) => c.id === picked);
          if (!item) return;
          // В справочнике ИНН — свободный текст. Наружу только цифры, и только
          // если контрольные сошлись: иначе сервер отклонил бы сохранение
          // целиком, хотя название выбрано верно.
          onChange({ name: item.name, inn: normalizeInn(item.inn), source: 'directory' });
        }}
        onClear={() => {
          setSearch('');
          onChange(null);
        }}
        // Ошибку загрузки отличаем от «ничего не найдено»: упавший GET иначе
        // выглядел бы пустым справочником. Ручной ввод при этом доступен.
        notFoundContent={
          list.isLoading ? (
            <Spin size="small" />
          ) : list.isError ? (
            <div style={{ padding: 8, textAlign: 'center' }}>
              <Typography.Text type="secondary">Справочник не загрузился</Typography.Text>{' '}
              <Button size="small" type="link" onClick={() => void list.refetch()}>
                Повторить
              </Button>
            </div>
          ) : (
            'Ничего не найдено — наберите название, чтобы ввести вручную'
          )
        }
        style={{ width: '100%' }}
      />
      {value?.source === 'manual' && (
        <>
          <Input
            aria-label={`${ariaLabel}: ИНН`}
            placeholder="ИНН (необязательно)"
            inputMode="numeric"
            maxLength={20}
            value={value.inn ?? ''}
            status={innInvalid ? 'error' : undefined}
            onChange={(e) => onChange({ ...value, inn: e.target.value || null })}
          />
          {innInvalid && (
            <Typography.Text type="danger">
              ИНН не прошёл проверку: нужно 10 или 12 цифр с верной контрольной суммой
            </Typography.Text>
          )}
        </>
      )}
    </Space>
  );
}
