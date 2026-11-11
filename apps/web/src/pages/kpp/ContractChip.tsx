import { useRef, useState } from 'react';
import { Button, Popconfirm, Popover, Space, Tag, Typography } from 'antd';
import { DisconnectOutlined, SwapOutlined } from '@ant-design/icons';
import type { DeliveryContract } from '@matcheck/contracts';
import { formatMsk } from '../../shared/utils/estimatOrder';
import {
  contractDateRu,
  contractShortLabel,
  contractWarnings,
  siteMatchTag,
} from '../../shared/utils/supplierContract';

/**
 * Чип «Договор» в шапке приёмки. Оранжевый, если что-то не сходится: другой
 * поставщик или объект, спорный объект, договор пропал из выгрузки 1С или
 * сменил вид. Клик — подробности, «Заменить» и «Отвязать».
 *
 * «Отвязать» фиксирует договор в момент открытия подтверждения: если пока оно
 * открыто, опрос принёс чужую замену, запрос уйдёт с прежним id и сервер
 * ответит 409 — отвязать то, чего человек не видел, нельзя.
 */
export function ContractChip({
  contract,
  label = 'Договор:',
  onUnlink,
  onReplace,
  unlinkPending = false,
}: {
  contract: DeliveryContract | null;
  /** Подпись чипа: «Договор:» или «Договор (общий):» в режиме «разные получатели». */
  label?: string;
  /** undefined — прав нет, кнопок не будет. Аргумент — договор, который человек видел. */
  onUnlink?: (expectedContractId: string) => void;
  onReplace?: () => void;
  unlinkPending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expected = useRef<string | null>(null);
  if (!contract) return null;

  const warnings = contractWarnings(contract);
  const site = siteMatchTag(contract.siteMatch, contract.siteCodes);

  const details = (
    <Space direction="vertical" size={6} style={{ maxWidth: 460 }} data-testid="contract-chip-details">
      <Typography.Text strong>{contract.name}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {contract.counterpartyName} · ИНН {contract.counterpartyInn}
        {contract.number ? ` · № ${contract.number}` : ''} · {contractDateRu(contract.contractDate)}
      </Typography.Text>
      <Space size={4} wrap>
        <Tag color={site.color} style={{ marginInlineEnd: 0 }}>
          {site.text}
        </Tag>
      </Space>
      {warnings.length > 0 && (
        <Space direction="vertical" size={2}>
          {warnings.map((w) => (
            <Typography.Text key={w} type="warning" style={{ fontSize: 12 }}>
              {w}
            </Typography.Text>
          ))}
        </Space>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Выбран {formatMsk(contract.linkedAt)}
        {contract.linkedByName ? ` · ${contract.linkedByName}` : ''}
      </Typography.Text>
      {(onReplace || onUnlink) && (
        <Space size={8}>
          {onReplace && (
            <Button
              size="small"
              icon={<SwapOutlined />}
              onClick={() => {
                setOpen(false);
                onReplace();
              }}
            >
              Заменить
            </Button>
          )}
          {onUnlink && (
            <Popconfirm
              title="Отвязать договор?"
              description="Договор останется в справочнике «Договоры»."
              okText="Отвязать"
              cancelText="Отмена"
              onOpenChange={(o) => {
                if (o) expected.current = contract.id;
              }}
              onConfirm={() => {
                if (expected.current) onUnlink(expected.current);
              }}
            >
              <Button size="small" danger icon={<DisconnectOutlined />} disabled={unlinkPending}>
                Отвязать
              </Button>
            </Popconfirm>
          )}
        </Space>
      )}
    </Space>
  );

  return (
    <Popover content={details} trigger="click" placement="bottomLeft" open={open} onOpenChange={setOpen}>
      <Tag
        color={warnings.length > 0 ? 'orange' : 'blue'}
        style={{ marginInlineEnd: 0, cursor: 'pointer' }}
        data-testid="contract-chip"
        data-warn={warnings.length > 0 ? 'true' : 'false'}
        title={contract.name}
      >
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {label}
        </Typography.Text>{' '}
        <Typography.Text strong style={{ fontSize: 12 }}>
          {contractShortLabel(contract)}
        </Typography.Text>
      </Tag>
    </Popover>
  );
}
