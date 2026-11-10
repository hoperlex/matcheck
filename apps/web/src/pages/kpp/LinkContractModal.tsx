import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Space, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ContractCandidate,
  ContractCandidatesResponse,
  DeliveryContract,
  DeliveryContractChanged,
  DeliveryContractResponse,
} from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { formatMsk } from '../../shared/utils/estimatOrder';
import { contractDateRu, contractShortLabel, siteMatchTag } from '../../shared/utils/supplierContract';

const PAGE_SIZE = 20;
/** Пока окно открыто — перечитываем кандидатов: метки зависят от документов приёмки. */
export const CONTRACT_CANDIDATES_REFRESH_MS = 30_000;

/** Ключи, которые сбрасывает любое изменение договора приёмки. */
export function contractQueryKeys(deliveryId: string | null) {
  return {
    contract: ['delivery-contract', deliveryId] as const,
    candidates: ['delivery-contract-candidates', deliveryId] as const,
  };
}

/**
 * Окно выбора договора 1С для приёмки. По умолчанию — договоры поставщика
 * приёмки (по ИНН из документов), сверху — договоры этого объекта. Объект —
 * подсказка правил, а не запрет: выбирает человек.
 *
 * Ожидаемый договор фиксируется в момент нажатия «Выбрать»: пара «был A →
 * станет B» живёт в замыкании подтверждения, и PUT уходит ровно с A. Если пока
 * открыто подтверждение, опрос принёс чужую замену на C, сервер ответит 409 —
 * заменить то, чего человек не видел, нельзя.
 */
export function LinkContractModal({
  open,
  deliveryId,
  current,
  onClose,
}: {
  open: boolean;
  deliveryId: string | null;
  /** Договор приёмки, который сейчас видит человек. */
  current: DeliveryContract | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const keys = contractQueryKeys(deliveryId);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [allSuppliers, setAllSuppliers] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setSearch('');
    setQuery('');
    setAllSuppliers(false);
    setPage(1);
    setError(null);
  }, [open]);

  const offset = (page - 1) * PAGE_SIZE;
  const candidates = useQuery({
    queryKey: [...keys.candidates, query, allSuppliers, offset],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (query) params.set('q', query);
      if (allSuppliers) params.set('allSuppliers', '1');
      return api.get<ContractCandidatesResponse>(`/deliveries/${deliveryId}/contract-candidates?${params.toString()}`);
    },
    enabled: open && !!deliveryId,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: open ? CONTRACT_CANDIDATES_REFRESH_MS : false,
  });

  const refreshBoth = () => {
    void queryClient.invalidateQueries({ queryKey: keys.contract });
    void queryClient.invalidateQueries({ queryKey: keys.candidates });
  };

  const link = useMutation({
    mutationFn: (body: { contractId: string; replaceContractId: string | null }) =>
      api.put<DeliveryContractResponse>(`/deliveries/${deliveryId}/contract`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(keys.contract, data);
      void queryClient.invalidateQueries({ queryKey: keys.candidates });
      onClose();
    },
    onError: (err) => {
      refreshBoth();
      if (err instanceof ApiError && err.status === 409 && err.code === 'contract_changed') {
        const payload = err.payload as DeliveryContractChanged | undefined;
        const now = payload?.current;
        setError(
          now
            ? `Договор приёмки уже изменил другой пользователь: «${contractShortLabel(now)}». Список обновлён — выберите ещё раз.`
            : 'Договор приёмки уже отвязал другой пользователь. Список обновлён — выберите ещё раз.',
        );
        return;
      }
      setError(err instanceof Error ? err.message : 'Не удалось выбрать договор');
    },
  });

  const choose = (candidate: ContractCandidate) => {
    setError(null);
    // Пара фиксируется здесь, по тому, что человек видит сейчас.
    const expected = current;
    const body = { contractId: candidate.id, replaceContractId: expected?.id ?? null };
    if (!expected) {
      link.mutate(body);
      return;
    }
    Modal.confirm({
      centered: true,
      title: 'Заменить договор приёмки?',
      content: (
        <Space direction="vertical" size={4}>
          <Typography.Text>
            Сейчас: <Typography.Text strong>{contractShortLabel(expected)}</Typography.Text>
          </Typography.Text>
          <Typography.Text>
            Станет: <Typography.Text strong>{contractShortLabel(candidate)}</Typography.Text>
          </Typography.Text>
        </Space>
      ),
      okText: 'Заменить',
      cancelText: 'Отмена',
      onOk: () => link.mutate(body),
    });
  };

  const data = candidates.data;
  const ctx = data?.context;
  const importedText = ctx?.importedAt ? `Договоры 1С загружены ${formatMsk(ctx.importedAt)} (МСК).` : '';

  const columns: ColumnsType<ContractCandidate> = [
    {
      title: 'Договор',
      render: (_v, r) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Typography.Text style={{ whiteSpace: 'normal' }}>{r.name}</Typography.Text>
          <Space size={4} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.number ? `№ ${r.number} · ` : ''}
              {contractDateRu(r.contractDate)}
            </Typography.Text>
            {r.missing && <Tag color="orange">нет в последней выгрузке</Tag>}
          </Space>
        </Space>
      ),
    },
    {
      title: 'Контрагент',
      width: 260,
      render: (_v, r) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Typography.Text ellipsis={{ tooltip: r.counterpartyName }} style={{ display: 'block' }}>
            {r.counterpartyName}
          </Typography.Text>
          <Space size={4} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ИНН {r.counterpartyInn}
            </Typography.Text>
            {r.supplierMatch === true && <Tag color="green">поставщик приёмки</Tag>}
          </Space>
        </Space>
      ),
    },
    {
      title: 'Объект',
      width: 200,
      render: (_v, r) => {
        const t = siteMatchTag(r.siteMatch, r.siteCodes);
        return (
          <Tag color={t.color} style={{ whiteSpace: 'normal', marginInlineEnd: 0 }}>
            {t.text}
          </Tag>
        );
      },
    },
    {
      title: '',
      width: 110,
      fixed: 'right',
      render: (_v, r) =>
        r.current ? (
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            Текущий
          </Tag>
        ) : (
          <Button size="small" type="primary" loading={link.isPending} onClick={() => choose(r)}>
            Выбрать
          </Button>
        ),
    },
  ];

  const emptyText = (() => {
    if (query) return `Ничего не найдено по «${query}»`;
    if (ctx?.filteredBySupplier) {
      return (
        <Space direction="vertical" size={6} data-testid="contract-empty-supplier">
          <Typography.Text>
            В выгрузке 1С (группа Снабжение{ctx.importedAt ? `, загружена ${formatMsk(ctx.importedAt, false)}` : ''})
            договоров с ИНН {ctx.supplierInns.join(', ')} нет. Если договор есть в 1С, его нужно добавить в выгрузку и
            загрузить заново.
          </Typography.Text>
          <Button
            size="small"
            onClick={() => {
              setAllSuppliers(true);
              setPage(1);
            }}
          >
            Искать среди всех договоров
          </Button>
        </Space>
      );
    }
    return 'Договоров нет';
  })();

  return (
    <Modal
      open={open}
      onCancel={() => {
        if (!link.isPending) onClose();
      }}
      title="Выбрать договор 1С"
      width="min(1200px, 96vw)"
      footer={null}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary" data-testid="contract-modal-context">
          {ctx
            ? ctx.supplierKnown
              ? `Договоры поставщика приёмки (ИНН ${ctx.supplierInns.join(', ')})${
                  ctx.filteredBySupplier ? '' : ' — сверху, ниже все остальные'
                }. Сверху — договоры объекта ${ctx.siteCode ?? 'приёмки'}.`
              : 'Поставщик приёмки не определён — ищите по номеру, адресу или ИНН.'
            : null}{' '}
          {importedText}
        </Typography.Text>
        {error && <Alert type="error" showIcon message={error} />}
        {candidates.isError && <Alert type="error" showIcon message="Не удалось загрузить договоры" />}
        <Space wrap size="middle">
          <Input.Search
            placeholder="Номер, адрес, контрагент или ИНН"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onSearch={(value) => {
              setQuery(value.trim());
              setPage(1);
            }}
            allowClear
            enterButton="Найти"
            style={{ width: 420 }}
          />
          {ctx?.supplierKnown && (
            <Space size={6}>
              <Switch
                checked={allSuppliers}
                onChange={(v) => {
                  setAllSuppliers(v);
                  setPage(1);
                }}
                aria-label="Все поставщики"
              />
              <Typography.Text>Все поставщики</Typography.Text>
            </Space>
          )}
        </Space>
        <Table<ContractCandidate>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={candidates.isLoading}
          tableLayout="fixed"
          scroll={{ x: 1000 }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: data?.total ?? 0,
            showSizeChanger: false,
            hideOnSinglePage: true,
            onChange: setPage,
          }}
          locale={{ emptyText }}
        />
      </Space>
    </Modal>
  );
}
