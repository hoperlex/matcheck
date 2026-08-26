import { Button, Empty, Skeleton, Space, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { StatsSummaryResponse } from '@matcheck/contracts';

interface Props {
  data: StatsSummaryResponse | undefined;
  loading: boolean;
  /**
   * Фильтры, по которым посчитаны сами числа. Ссылка обязана их переносить:
   * плашка считает за выбранный период и по выбранным объектам, а список без
   * этих параметров показывал всё за всю историю — число на плашке и число в
   * списке расходились на порядки.
   */
  scope?: { siteIds: string[]; dateFrom: string | null; dateTo: string | null };
}

type CounterDef = {
  key: string;
  label: string;
  hint?: string;
  value: number;
  // Куда уезжать по клику. Возвращаем null для counter'ов, для которых
  // готовый URL-фильтр в /operations пока не реализован — кнопка тогда
  // disabled, текст подсвечивается серым.
  target: string | null;
};

/**
 * Список actionable-counters «Требует внимания» — по UX-ревью лучше, чем
 * любой график: сразу отвечает «что чинить сегодня». Каждый — кликабельный
 * Button type="text" с переходом в /operations с предзаданными query
 * params. Если URL-фильтр для счётчика ещё не реализован — счётчик
 * показывается, но как disabled (избегаем тупиковых ссылок).
 */
export function AttentionCounters({ data, loading, scope }: Props) {
  const navigate = useNavigate();

  // Хвост общих параметров для ссылок в «Операции»: объект и период.
  const scopeQs = (kind: 'operations' | 'documents'): string => {
    const qs = new URLSearchParams();
    if (scope?.siteIds.length) qs.set('site', scope.siteIds.join(','));
    if (kind === 'operations') {
      if (scope?.dateFrom) qs.set('dfrom', scope.dateFrom.slice(0, 10));
      if (scope?.dateTo) qs.set('dto', scope.dateTo.slice(0, 10));
    } else {
      if (scope?.dateFrom) qs.set('docFrom', scope.dateFrom.slice(0, 10));
      if (scope?.dateTo) qs.set('docTo', scope.dateTo.slice(0, 10));
    }
    const str = qs.toString();
    return str ? `&${str}` : '';
  };

  if (loading && !data) {
    return <Skeleton.Input active style={{ width: '100%', height: 64 }} />;
  }
  if (!data) return null;

  const a = data.attention;
  const total =
    a.noDocumentDeliveries +
    a.noDocumentShipments +
    a.noPhotosDeliveries +
    a.noPhotosShipments +
    a.overdue +
    a.mismatchDocs +
    a.transit;

  if (total === 0) {
    return (
      <Empty description="Всё в порядке за выбранный период" image={Empty.PRESENTED_IMAGE_SIMPLE} />
    );
  }

  // URL-таргеты: те же фильтры, по которым считались числа. «Без фото» несёт
  // ещё и порог возраста (nophotoHours): плашка считает операции старше 12
  // часов, и без этого параметра список показывал бы вдобавок свежие, у
  // которых фото ещё грузятся.
  const counters: CounterDef[] = [
    {
      key: 'no-doc-delivery',
      label: 'Приёмки без УПД',
      value: a.noDocumentDeliveries,
      target: `/operations?type=delivery&tab=accepted&status=no_document${scopeQs('operations')}`,
    },
    {
      key: 'no-doc-shipment',
      label: 'Отгрузки без УПД',
      value: a.noDocumentShipments,
      target: `/operations?type=shipment&tab=accepted&status=no_document${scopeQs('operations')}`,
    },
    {
      key: 'no-photo-delivery',
      label: 'Приёмки без фото',
      value: a.noPhotosDeliveries,
      target: `/operations?type=delivery&tab=accepted&nophoto=1&nophotoHours=12${scopeQs('operations')}`,
    },
    {
      key: 'no-photo-shipment',
      label: 'Отгрузки без фото',
      value: a.noPhotosShipments,
      target: `/operations?type=shipment&tab=accepted&nophoto=1&nophotoHours=12${scopeQs('operations')}`,
    },
    {
      key: 'overdue',
      label: 'Просрочено',
      hint: 'Filled/shipped без подтверждения МОЛ со вчера и старше',
      value: a.overdue,
      target: null,
    },
    {
      key: 'mismatch',
      label: 'Расхождение сумм',
      hint: 'Документы с parseError validation_mismatch',
      value: a.mismatchDocs,
      target: `/documents?mismatch=1${scopeQs('documents')}`,
    },
    {
      key: 'transit',
      label: 'Транзит',
      hint: 'Чекбокс «Транзит» в мобиле — машина едет дальше с чужим грузом',
      value: a.transit,
      // Транзит включает обе стороны; для прямого перехода ведём в
      // Приёмку — там этот признак чаще встречается по бизнес-смыслу.
      target: `/operations?type=delivery&tab=accepted&feature=transit${scopeQs('operations')}`,
    },
  ];

  return (
    <Space size={[12, 8]} wrap style={{ width: '100%' }}>
      {counters
        .filter((c) => c.value > 0)
        .map((c) => {
          const content = (
            <Button
              key={c.key}
              type="text"
              disabled={c.target === null}
              onClick={() => c.target && navigate(c.target)}
              style={{
                height: 'auto',
                padding: '6px 12px',
                background: '#fffbe6',
                border: '1px solid #ffe58f',
                borderRadius: 6,
                lineHeight: 1.3,
              }}
            >
              <Space direction="vertical" size={0} align="start">
                <Typography.Text strong style={{ fontSize: 18 }}>
                  {c.value}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {c.label}
                </Typography.Text>
              </Space>
            </Button>
          );
          return c.hint ? (
            <Tooltip key={c.key} title={c.hint}>
              {content}
            </Tooltip>
          ) : (
            content
          );
        })}
    </Space>
  );
}
