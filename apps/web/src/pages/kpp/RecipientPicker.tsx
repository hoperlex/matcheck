import { Segmented, Select, Space, Typography } from 'antd';
import { CustomerCounterpartySelect } from '../inbox/CustomerCounterpartySelect';

export type RecipientKind = 'counterparty' | 'mol';

/** Один выбор получателя для общей шапки и отдельного УПД. */
export function RecipientPicker({
  kind,
  onKindChange,
  contractorId,
  contractorName,
  recipientMolId,
  canPickContractor,
  mols,
  molsLoading,
  onContractorChange,
  onMolChange,
}: {
  kind: RecipientKind;
  onKindChange: (kind: RecipientKind) => void;
  contractorId: string | null;
  contractorName: string | null;
  recipientMolId: string | null;
  canPickContractor: boolean;
  mols: { id: string; fullName: string }[];
  molsLoading: boolean;
  onContractorChange: (id: string | null, name: string | null) => void;
  onMolChange: (id: string | null) => void;
}) {
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Segmented
        block
        size="small"
        options={[
          { label: 'Подрядчик', value: 'counterparty' },
          { label: 'МОЛ', value: 'mol' },
        ]}
        value={kind}
        onChange={(value) => onKindChange(value as RecipientKind)}
      />
      {kind === 'counterparty' ? (
        <CustomerCounterpartySelect
          autoFocus
          context="delivery"
          placeholder="— не указан —"
          value={contractorId}
          displayName={contractorName}
          disabled={!canPickContractor}
          onChange={(id, cp) => onContractorChange(id, cp?.name ?? null)}
        />
      ) : (
        <Select<string>
          autoFocus
          style={{ width: '100%' }}
          placeholder="— не указан —"
          value={recipientMolId ?? undefined}
          onChange={(value) => onMolChange(value ?? null)}
          allowClear
          showSearch
          optionFilterProp="label"
          loading={molsLoading}
          options={mols.map((m) => ({ value: m.id, label: m.fullName }))}
          notFoundContent={<Typography.Text type="secondary">МОЛ не найдены</Typography.Text>}
        />
      )}
    </Space>
  );
}
