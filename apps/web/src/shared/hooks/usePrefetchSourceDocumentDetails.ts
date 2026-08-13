import { useQueries } from '@tanstack/react-query';
import type { SourceDocumentDetail } from '@matcheck/contracts';
import { api } from '../../services/api';
import { createLoadQueue } from '../../lib/thumbQueue';

/**
 * Фоновый префетч позиций source-document'ов сразу после рендера списка.
 * Раскрытие строки по «+» и открытие карточки не дёргают сеть —
 * `ExpandedSourceDocumentItems` и `SourceDocumentDetailModal` используют тот же
 * queryKey (`['source-document', id]`) и читают готовый кэш react-query.
 *
 * Почему префетчим только начало списка. `useQueries` по своей природе
 * запускает все переданные запросы параллельно, а прежний комментарий здесь
 * рассчитывал на браузерный лимит в 6 соединений — после включения HTTP/2 его
 * не стало. На боевых 225 входящих документах открытие раздела давало ~225
 * одновременных запросов, каждый из которых стоит на сервере 3–9 SQL. Очередь
 * одна такую нагрузку не лечит: она растягивает залп во времени, но не
 * уменьшает объём работы и не умеет отменять уже поставленные задачи.
 *
 * Поэтому греем PREFETCH_LIMIT первых строк — тех, что пользователь видит
 * сразу, — и пропускаем их через общий лимитер. Остальные строки грузят деталь
 * по клику: одна карточка вместо двух сотен.
 *
 * Порядок — это порядок ответа API (по умолчанию parsed_at DESC), а НЕ текущая
 * сортировка таблицы: пользовательская сортировка живёт внутри antd Table
 * (см. ResponsiveTable), родителю она недоступна. То есть префетч — это
 * «подогрев начала выдачи», а не угадывание видимой страницы.
 */
const PREFETCH_LIMIT = 10;

/**
 * Лимитер параллелизма — ОДИН на модуль, а не на вызов хука: новый экземпляр
 * на каждый рендер перестал бы быть общим ограничением, и два списка на экране
 * снова дали бы залп.
 */
const enqueueSdDetailLoad = createLoadQueue(4);

export function usePrefetchSourceDocumentDetails(ids: readonly string[]): void {
  useQueries({
    queries: ids.slice(0, PREFETCH_LIMIT).map((id) => ({
      queryKey: ['source-document', id],
      queryFn: () => enqueueSdDetailLoad(() => api.get<SourceDocumentDetail>(`/source-documents/${id}`)),
      staleTime: 5 * 60 * 1000,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
    })),
  });
}
