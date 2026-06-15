import { Button, Empty, Skeleton, Space, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { StatsSummaryResponse } from '@matcheck/contracts';

interface Props {
  data: StatsSummaryResponse | undefined;
  loading: boolean;
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
export function AttentionCounters({ data, loading }: Props) {
  const navigate = useNavigate();

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
      <Empty
        description="Всё в порядке за выбранный период"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  // URL-таргеты: используем уже работающие в Операциях фильтры —
  // status=no_document, feature=transit. nophoto=1 — флаг, который
  // добавляется отдельным мини-патчем (см. DeliveriesHistory). Для
  // recognized validation_mismatch у нас уже есть статус-проверка через
  // sourceDocsById на клиенте; готового URL-фильтра под него в Операциях
  // нет, и счётчик ведёт на /documents (где валидация и происходит).
  const counters: CounterDef[] = [
    {
      key: 'no-doc-delivery',
      label: 'Приёмки без УПД',
      value: a.noDocumentDeliveries,
      target: '/operations?type=delivery&tab=accepted&status=no_document',
    },
    {
      key: 'no-doc-shipment',
      label: 'Отгрузки без УПД',
      value: a.noDocumentShipments,
      target: '/operations?type=shipment&tab=accepted&status=no_document',
    },
    {
      key: 'no-photo-delivery',
      label: 'Приёмки без фото',
      value: a.noPhotosDeliveries,
      target: '/operations?type=delivery&tab=accepted&nophoto=1',
    },
    {
      key: 'no-photo-shipment',
      label: 'Отгрузки без фото',
      value: a.noPhotosShipments,
      target: '/operations?type=shipment&tab=accepted&nophoto=1',
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
      target: '/documents',
    },
    {
      key: 'transit',
      label: 'Транзит',
      hint: 'Чекбокс «Транзит» в мобиле — машина едет дальше с чужим грузом',
      value: a.transit,
      // Транзит включает обе стороны; для прямого перехода ведём в
      // Приёмку — там этот признак чаще встречается по бизнес-смыслу.
      target: '/operations?type=delivery&tab=accepted&feature=transit',
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
