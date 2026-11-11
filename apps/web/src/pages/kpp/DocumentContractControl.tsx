import { Button, Tooltip } from 'antd';
import type { DeliveryContract } from '@matcheck/contracts';
import { contractShortLabel } from '../../shared/utils/supplierContract';
import { ContractChip } from './ContractChip';

/**
 * Договор 1С строки УПД в режиме «Разные получатели по документам».
 *
 * - Свой договор есть — чип «Договор: …» с «Заменить» и «Отвязать»; после
 *   отвязки документ снова наследует общий договор приёмки.
 * - Своего нет — «+ Договор» (как «+ ЭДО»); подсказка говорит, какой общий
 *   договор сейчас действует для этого документа.
 * - Без права выбора — только чип своего договора, если он есть.
 */
export function DocumentContractControl({
  own,
  general,
  canLink,
  onPick,
  onUnlink,
  unlinkPending = false,
}: {
  /** Свой договор документа. */
  own: DeliveryContract | null;
  /** Общий договор приёмки — его документ наследует, пока своего нет. */
  general: DeliveryContract | null;
  /** Можно выбирать: право, справочник не пуст, приёмка не на удалении. */
  canLink: boolean;
  onPick: () => void;
  /** Аргумент — договор, который человек видел при открытии подтверждения. */
  onUnlink: (expectedContractId: string) => void;
  unlinkPending?: boolean;
}) {
  if (own) {
    return (
      <ContractChip
        contract={own}
        onReplace={canLink ? onPick : undefined}
        onUnlink={canLink ? onUnlink : undefined}
        unlinkPending={unlinkPending}
      />
    );
  }
  if (!canLink) return null;
  const hint = general
    ? `Сейчас действует общий договор приёмки: ${contractShortLabel(general)}`
    : 'Общий договор приёмки не выбран';
  return (
    <Tooltip title={hint}>
      <Button size="small" type="dashed" onClick={onPick} data-testid="document-contract-add">
        + Договор
      </Button>
    </Tooltip>
  );
}
