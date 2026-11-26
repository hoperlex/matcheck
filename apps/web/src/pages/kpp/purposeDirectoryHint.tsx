// Подсказка «Признака» по справочнику «Контрагенты → Объекты и вид» в карточке
// приёмки (миграция 0161, domain/operations/delivery-purpose.ts на сервере).
//   - признак поставил справочник → «📒 по справочнику», кнопка в цвете вида;
//   - человек выбрал то же, что в справочнике → «✓ совпадает со справочником»;
//   - иначе (выбрано другое или пусто) → серым «справочник: …»;
//   - в меню пункты из справочника помечены «📒 по справочнику».
// Выбрать можно любой допустимый пункт — подсказка ничего не запрещает.
import type { ReactNode } from 'react';
import { Tag, Tooltip, Typography, type ButtonProps } from 'antd';
import {
  CONTRACTOR_SITE_KIND_LABELS,
  DELIVERY_PURPOSE_LABELS,
  directoryPurposeHint,
  type DeliveryPurpose,
  type DeliveryPurposeHint,
} from '@matcheck/contracts';
import { CONTRACTOR_SITE_KIND_COLORS } from '../references/contractorSites';

export type PurposeDirectoryState = 'auto' | 'match' | 'differs' | 'none';

/** Как признак соотносится со справочником. */
export function purposeDirectoryState(
  hint: DeliveryPurposeHint | null | undefined,
  purpose: DeliveryPurpose | null,
  fromDirectory: boolean,
): PurposeDirectoryState {
  if (!hint) return 'none';
  const { highlight } = directoryPurposeHint(hint.kind);
  if (highlight.length === 0) return 'none';
  if (purpose !== null && highlight.includes(purpose)) return fromDirectory ? 'auto' : 'match';
  return 'differs';
}

/** Цвет кнопки «Признак», если признак поставил справочник (пресет antd). */
export function purposeButtonColor(
  hint: DeliveryPurposeHint | null | undefined,
  state: PurposeDirectoryState,
): ButtonProps['color'] | undefined {
  return state === 'auto' && hint
    ? (CONTRACTOR_SITE_KIND_COLORS[hint.kind] as ButtonProps['color'])
    : undefined;
}

function hintTitle(hint: DeliveryPurposeHint): string {
  return (
    `Справочник «Контрагенты» → «Объекты и вид»: ${hint.siteCode} · ` +
    `${CONTRACTOR_SITE_KIND_LABELS[hint.kind]} (${hint.manual ? 'указан вручную' : 'из 1С'})`
  );
}

/** Отметка рядом с кнопкой «Признак». */
export function PurposeDirectoryMark({
  hint,
  state,
}: {
  hint: DeliveryPurposeHint | null | undefined;
  state: PurposeDirectoryState;
}) {
  if (!hint || state === 'none') return null;
  const title = hintTitle(hint);
  if (state === 'auto') {
    return (
      <Tooltip title={title}>
        <Tag
          color={CONTRACTOR_SITE_KIND_COLORS[hint.kind]}
          style={{ marginInlineEnd: 0 }}
          data-testid="purpose-directory-mark"
        >
          📒 по справочнику
        </Tag>
      </Tooltip>
    );
  }
  if (state === 'match') {
    return (
      <Tooltip title={title}>
        <Typography.Text type="secondary" data-testid="purpose-directory-mark">
          ✓ совпадает со справочником
        </Typography.Text>
      </Tooltip>
    );
  }
  const labels = directoryPurposeHint(hint.kind)
    .highlight.map((p) => DELIVERY_PURPOSE_LABELS[p])
    .join(' / ');
  return (
    <Tooltip title={title}>
      <Typography.Text type="secondary" data-testid="purpose-directory-mark">
        справочник: {labels}
      </Typography.Text>
    </Tooltip>
  );
}

/** Подпись пункта меню: пункты из справочника помечены. */
export function purposeMenuLabel(
  key: DeliveryPurpose,
  label: string,
  hint: DeliveryPurposeHint | null | undefined,
): ReactNode {
  if (!hint || !directoryPurposeHint(hint.kind).highlight.includes(key)) return label;
  return (
    <span>
      {label}{' '}
      <Tag
        color={CONTRACTOR_SITE_KIND_COLORS[hint.kind]}
        style={{ marginInlineStart: 8, marginInlineEnd: 0 }}
      >
        📒 по справочнику
      </Tag>
    </span>
  );
}
