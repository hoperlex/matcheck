import { useQueries } from '@tanstack/react-query';
import type { SourceDocumentDetail } from '@matcheck/contracts';
import { api } from '../../services/api';

/**
 * Фоновый префетч позиций source-document'ов сразу после рендера списка.
 * Раскрытие строки + по «+» больше не дёргает сеть — `ExpandedSourceDocumentItems`
 * использует тот же queryKey (`['source-document-detail', id]`) и читает
 * готовый кэш react-query.
 *
 * Параллельность ограничена браузером (HTTP/2 — десятки одновременных
 * соединений). staleTime 5 минут гарантирует, что повторный заход в раздел
 * не запускает префетч заново; refetchOnMount=false — что и при ремонте
 * компонента запрос не идёт, пока кэш свежий.
 */
export function usePrefetchSourceDocumentDetails(ids: readonly string[]): void {
  useQueries({
    queries: ids.map((id) => ({
      queryKey: ['source-document-detail', id],
      queryFn: () => api.get<SourceDocumentDetail>(`/source-documents/${id}`),
      staleTime: 5 * 60 * 1000,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
    })),
  });
}
