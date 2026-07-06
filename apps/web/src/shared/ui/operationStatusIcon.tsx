import type { ReactNode } from 'react';
import { Space, Tooltip, Typography } from 'antd';
import {
  FormOutlined,
  CheckCircleOutlined,
  CarOutlined,
  ClockCircleOutlined,
  FileExclamationOutlined,
  TagOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';

// Значок для кода статуса операции (приёмка/отгрузка). Неизвестный код — общий
// значок-«тег». Цвет берётся из самого статуса (r.status.color, как настроен в
// справочнике статусов), поэтому значок в ячейке и в легенде совпадают по цвету
// с прежним текстовым тегом. Меняется ТОЛЬКО представление (слово → значок) —
// данные и коды статусов не затрагиваются.
const STATUS_ICON: Record<string, ReactNode> = {
  filled: <FormOutlined />, // Оформлена (приёмка)
  shipped: <CarOutlined />, // Отгружена (отгрузка)
  confirmed_mol: <CheckCircleOutlined />, // Подтверждено МОЛ
  arrived: <ClockCircleOutlined />, // Прибыла / ожидается
};

export function statusIconFor(code: string): ReactNode {
  return STATUS_ICON[code] ?? <TagOutlined />;
}

export const NO_DOC_COLOR = '#faad14';
// Цвета значков отметки проверки (роль «Мониторинг»): зелёный «Проверено»,
// красный «Есть замечания». Совпадают с текстовым ReviewBadge в модалках.
export const REVIEW_APPROVED_COLOR = '#52c41a';
export const REVIEW_ISSUES_COLOR = '#ff4d4f';
const ICON_SIZE = 18;

/**
 * Компактный значок отметки проверки для столбца «Статус». Для «Проверено»
 * намеренно НЕ галочка (CheckCircle занята статусом «Подтверждено МОЛ») —
 * значок «сертификат/качество», чтобы не путать два смысла. `null`/пусто (не
 * проверено) → ничего не рисуем. Приходит в DTO только менеджменту.
 */
export function ReviewStatusIcon({
  state,
}: {
  state: 'approved' | 'issues' | null | undefined;
}): JSX.Element | null {
  if (state === 'approved') {
    return (
      <Tooltip title="Проверено">
        <SafetyCertificateOutlined style={{ color: REVIEW_APPROVED_COLOR, fontSize: ICON_SIZE }} />
      </Tooltip>
    );
  }
  if (state === 'issues') {
    return (
      <Tooltip title="Есть замечания">
        <WarningOutlined style={{ color: REVIEW_ISSUES_COLOR, fontSize: ICON_SIZE }} />
      </Tooltip>
    );
  }
  return null;
}

/**
 * Компактная ячейка столбца «Статус»: значки со всплывающей подсказкой (полный
 * текст статуса). Заменяет вертикальную стопку текстовых Tag'ов — строки таблицы
 * становятся ниже и визуально компактнее. `extra` — доп. содержимое (напр. тег
 * «в корзине» на вкладке «Удалённые»).
 */
export function StatusIconsCell({
  code,
  label,
  color,
  noDocument,
  extra,
}: {
  code: string;
  label: string;
  color: string | null;
  noDocument: boolean;
  extra?: ReactNode;
}): JSX.Element {
  return (
    <Space size={8}>
      <Tooltip title={label}>
        <span
          style={{
            color: color ?? undefined,
            fontSize: ICON_SIZE,
            lineHeight: 1,
            display: 'inline-flex',
          }}
        >
          {statusIconFor(code)}
        </span>
      </Tooltip>
      {noDocument && (
        <Tooltip title="Без документа">
          <FileExclamationOutlined style={{ color: NO_DOC_COLOR, fontSize: ICON_SIZE }} />
        </Tooltip>
      )}
      {extra}
    </Space>
  );
}

/**
 * Легенда значков статусов: значок + подпись. Расшифровывает столбец «Статус».
 * Список статусов передаётся из данных таблицы (реальные code/label/color) —
 * так легенда всегда соответствует тому, что показано в столбце. Плюс всегда
 * показываем «Без документа» (это не код статуса, а признак пустого документа).
 */
export function StatusLegend({
  statuses,
  showReview = false,
}: {
  statuses: { code: string; label: string; color: string | null }[];
  // Показать пункты отметки проверки (Проверено / Есть замечания) — только
  // менеджменту (admin/manager/monitor), т.к. только он видит эти значки.
  showReview?: boolean;
}): JSX.Element | null {
  if (statuses.length === 0) return null;
  return (
    <Space size={16} wrap style={{ paddingTop: 2 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Обозначения:
      </Typography.Text>
      {statuses.map((s) => (
        <Space key={s.code} size={4}>
          <span
            style={{ color: s.color ?? undefined, fontSize: 15, lineHeight: 1, display: 'inline-flex' }}
          >
            {statusIconFor(s.code)}
          </span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {s.label}
          </Typography.Text>
        </Space>
      ))}
      <Space size={4}>
        <FileExclamationOutlined style={{ color: NO_DOC_COLOR, fontSize: 15 }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Без документа
        </Typography.Text>
      </Space>
      {showReview && (
        <>
          <Space size={4}>
            <SafetyCertificateOutlined style={{ color: REVIEW_APPROVED_COLOR, fontSize: 15 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Проверено
            </Typography.Text>
          </Space>
          <Space size={4}>
            <WarningOutlined style={{ color: REVIEW_ISSUES_COLOR, fontSize: 15 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Есть замечания
            </Typography.Text>
          </Space>
        </>
      )}
    </Space>
  );
}
