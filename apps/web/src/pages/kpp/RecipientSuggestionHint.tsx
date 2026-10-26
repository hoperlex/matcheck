import { useRef } from 'react';
import { Button, Typography, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Counterparty,
  RecipientSuggestion,
  RecipientSuggestionResponse,
} from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';

/**
 * «по документу: СТРОЙСЕРВИС · Подставить» рядом с пустым чипом «Получатель».
 *
 * Список приёмок показывает покупателя и грузополучателя документа, а чип —
 * подрядчика самой приёмки, и при пустом чипе это выглядело как потеря
 * (приёмка 21514). Подставлять за человека нельзя (решение 7d62092: в ~40%
 * документов грузополучатель — сама СУ-10, а подрядчик приёмки даёт права роли
 * «подрядчик»), поэтому только подсказка. Применяется тем же
 * POST /counterparties/from-directory, что и ручной выбор, а сохраняет человек
 * обычной кнопкой.
 *
 * Отдельный компонент, а не хуки в KppPage: карточка рендерит его только когда
 * получатель пуст, и порядок хуков самой карточки не меняется. Ключ запроса не
 * под ['deliveries'] — иначе каждая SSE-инвалидация приёмок дёргала бы и его.
 */
export function RecipientSuggestionHint({
  deliveryId,
  sourceDocumentIds,
  onApply,
}: {
  deliveryId: string;
  sourceDocumentIds: readonly string[];
  /** Операционный контрагент, найденный по подсказке. */
  onApply: (counterparty: Counterparty) => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  // Ответ применяется только к той приёмке, для которой его запросили:
  // карточку могли переключить, пока запрос был в полёте.
  const currentDeliveryId = useRef(deliveryId);
  currentDeliveryId.current = deliveryId;

  const query = useQuery({
    queryKey: ['recipient-suggestion', deliveryId, sourceDocumentIds.join(',')],
    queryFn: () =>
      api.get<RecipientSuggestionResponse>(`/deliveries/${deliveryId}/recipient-suggestion`),
    staleTime: 60_000,
  });

  const apply = useMutation<
    Counterparty,
    Error,
    { deliveryId: string; suggestion: RecipientSuggestion }
  >({
    mutationFn: ({ suggestion }) =>
      api.post<Counterparty>('/counterparties/from-directory', {
        customerCounterpartyId: suggestion.customerCounterpartyId,
        context: 'delivery',
      }),
    onSuccess: (cp, vars) => {
      // Как у ручного выбора: резолюция могла создать контрагента или поднять
      // ему isContractor.
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
      if (vars.deliveryId !== currentDeliveryId.current) return;
      // Сервер нашёл контрагента не по ИНН подсказки (запись успели удалить) —
      // подставлять чужого нельзя.
      if ((cp.inn ?? '').replace(/\D/g, '') !== vars.suggestion.inn) {
        message.warning('Не удалось подставить — выберите подрядчика вручную');
        return;
      }
      onApply(cp);
    },
    onError: (err) => {
      message.error(err instanceof ApiError ? err.message : 'Не удалось подставить подрядчика');
    },
  });

  const suggestion = query.data?.suggestion;
  if (!suggestion) return null;
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      по документу: {suggestion.name} ·{' '}
      <Button
        type="link"
        size="small"
        style={{ padding: 0, height: 'auto', fontSize: 12 }}
        disabled={apply.isPending}
        onClick={() => apply.mutate({ deliveryId, suggestion })}
      >
        Подставить
      </Button>
    </Typography.Text>
  );
}
