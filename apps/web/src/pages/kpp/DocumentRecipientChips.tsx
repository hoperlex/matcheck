import { useState } from 'react';
import { Dropdown, Space, Tag, Typography } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import {
  allowedDeliveryPurposes,
  deliveryRecipientKind,
  effectiveDocumentRecipient,
  type Delivery,
  type DeliveryPurpose,
} from '@matcheck/contracts';
import { InlineEditChip } from '../../shared/ui/InlineEditChip';
import {
  DELIVERY_PURPOSE_LABELS,
  DELIVERY_PURPOSE_OPTIONS,
} from '../../shared/utils/deliveryPurpose';
import { RecipientPicker, type RecipientKind } from './RecipientPicker';

export type DocumentRecipientPatch =
  | { contractorId: string }
  | { recipientMolId: string }
  | { none: true }
  | { inherit: true };
export type DocumentPurposePatch = { purpose: DeliveryPurpose } | { inherit: true };

/** Чипы связанного УПД. Без прав показывают те же действующие значения текстом. */
export function DocumentRecipientChips({
  delivery,
  docId,
  canEditRecipient,
  canPickContractor,
  canEditPurpose,
  disabled,
  mols,
  molsLoading,
  onRecipient,
  onPurpose,
}: {
  delivery: Delivery;
  docId: string;
  canEditRecipient: boolean;
  canPickContractor: boolean;
  canEditPurpose: boolean;
  disabled?: boolean;
  mols: { id: string; fullName: string }[];
  molsLoading: boolean;
  onRecipient: (patch: DocumentRecipientPatch) => void;
  onPurpose: (patch: DocumentPurposePatch) => void;
}) {
  const own = delivery.documentRecipients?.find((x) => x.sourceDocumentId === docId);
  const doc = {
    ownRecipient: own?.ownRecipient ?? false,
    contractorId: own?.contractorId ?? null,
    recipientMolId: own?.recipientMolId ?? null,
    ownPurpose: own?.ownPurpose ?? false,
    purpose: own?.purpose ?? null,
  };
  const general = {
    contractorId: delivery.contractorId,
    recipientMolId: delivery.recipientMolId,
    purpose: delivery.purpose ?? null,
  };
  const effective = effectiveDocumentRecipient(general, doc);
  const [kind, setKind] = useState<RecipientKind>(
    effective.recipientMolId ? 'mol' : 'counterparty',
  );
  const name = doc.ownRecipient
    ? doc.contractorId
      ? own?.contractorName
      : doc.recipientMolId
        ? own?.recipientMolName
        : null
    : delivery.contractorId
      ? delivery.contractorName
      : delivery.recipientMolName;
  const recipientText = effective.contractorId
    ? `Подрядчик: ${name ?? '—'}`
    : effective.recipientMolId
      ? `МОЛ: ${name ?? '—'}`
      : '— не указан';
  const recipientLabel = doc.ownRecipient ? recipientText : `как у приёмки: ${recipientText}`;
  const purposeText = effective.purpose
    ? DELIVERY_PURPOSE_LABELS[effective.purpose]
    : '— не выбран';
  const purposeLabel = doc.ownPurpose ? purposeText : `как у приёмки: ${purposeText}`;
  const allowed = allowedDeliveryPurposes(deliveryRecipientKind(effective));
  const canInheritPurpose = !(
    doc.ownRecipient &&
    !!doc.contractorId &&
    general.purpose === 'own_forces'
  );

  return (
    <Space
      size={4}
      wrap
      style={{ maxWidth: 'min(60vw, 620px)' }}
      onClick={(event) => event.stopPropagation()}
    >
      {canEditRecipient ? (
        <InlineEditChip label="Получатель" value={recipientLabel} disabled={disabled} width={320}>
          {(close) => (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <RecipientPicker
                kind={kind}
                onKindChange={setKind}
                contractorId={effective.contractorId}
                contractorName={
                  kind === 'counterparty' && effective.contractorId ? (name ?? null) : null
                }
                recipientMolId={effective.recipientMolId}
                canPickContractor={canPickContractor}
                mols={mols}
                molsLoading={molsLoading}
                onContractorChange={(id) => {
                  onRecipient(id ? { contractorId: id } : { none: true });
                  close();
                }}
                onMolChange={(id) => {
                  onRecipient(id ? { recipientMolId: id } : { none: true });
                  close();
                }}
              />
              {doc.ownRecipient && (
                <Typography.Link
                  onClick={() => {
                    onRecipient({ inherit: true });
                    close();
                  }}
                >
                  Вернуть общего получателя
                </Typography.Link>
              )}
            </Space>
          )}
        </InlineEditChip>
      ) : (
        <Tag style={{ marginInlineEnd: 0 }}>Получатель: {recipientLabel}</Tag>
      )}
      {canEditPurpose ? (
        <Dropdown
          disabled={disabled}
          trigger={['click']}
          menu={{
            selectedKeys: doc.ownPurpose && doc.purpose ? [doc.purpose] : [],
            items: [
              ...DELIVERY_PURPOSE_OPTIONS.filter((option) => allowed.includes(option.key)),
              { type: 'divider' as const },
              {
                key: 'inherit',
                label: 'Вернуть общий признак',
                disabled: !doc.ownPurpose || !canInheritPurpose,
              },
            ],
            onClick: ({ key }) =>
              onPurpose(
                key === 'inherit' ? { inherit: true } : { purpose: key as DeliveryPurpose },
              ),
          }}
        >
          <Tag
            color={doc.ownPurpose ? 'blue' : undefined}
            style={{ cursor: disabled ? 'not-allowed' : 'pointer', marginInlineEnd: 0 }}
          >
            Признак: {purposeLabel} <DownOutlined />
          </Tag>
        </Dropdown>
      ) : (
        <Tag style={{ marginInlineEnd: 0 }}>Признак: {purposeLabel}</Tag>
      )}
    </Space>
  );
}
