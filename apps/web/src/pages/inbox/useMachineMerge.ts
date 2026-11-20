import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MachineMergeConfigResponse,
  MachineMergePreviewResponse,
  MachineMergeResponse,
  MachineUnmergeResponse,
} from '@matcheck/contracts';
import { api } from '../../services/api';

/**
 * Где включено объединение машин. Пока нигде — кнопка «Объединить» не
 * показывается. Право на маршрут — как у правки документов: у кого его нет,
 * запрос вернёт 403, и это тоже «нигде».
 */
export function useMachineMergeConfig(enabled: boolean) {
  return useQuery({
    queryKey: ['machine-merge', 'config'],
    queryFn: () => api.get<MachineMergeConfigResponse>('/source-documents/machine-merge/config'),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Включено ли объединение хоть где-то / на объекте. */
export function mergeEnabledFor(
  config: MachineMergeConfigResponse | undefined,
  siteId?: string | null,
): boolean {
  const sites = config?.enabledSites ?? [];
  if (sites.includes('*')) return true;
  if (siteId === undefined) return sites.length > 0;
  return !!siteId && sites.includes(siteId);
}

export function useMachineMergePreview(documentIds: string[] | null) {
  return useQuery({
    queryKey: ['machine-merge', 'preview', documentIds],
    queryFn: () =>
      api.post<MachineMergePreviewResponse>('/source-documents/machine-merge/preview', {
        documentIds,
      }),
    enabled: !!documentIds && documentIds.length > 0,
    // Предпросмотр — снимок перед решением: перечитываем при каждом открытии.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** После слияния или разъединения — заново список и карточки документов. */
function useInvalidateDocuments() {
  const qc = useQueryClient();
  return (documentIds: string[]) => {
    void qc.invalidateQueries({ queryKey: ['source-documents'] });
    for (const id of documentIds) {
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
    }
  };
}

export function useMachineMergeMutation() {
  const invalidate = useInvalidateDocuments();
  return useMutation({
    mutationFn: (body: { documentIds: string[]; expectedDocumentIds: string[] }) =>
      api.post<MachineMergeResponse>('/source-documents/machine-merge', body),
    onSuccess: (res) => invalidate(res.documentIds),
  });
}

export function useMachineUnmergeMutation() {
  const invalidate = useInvalidateDocuments();
  return useMutation({
    mutationFn: (body: { documentId: string; expectedDocumentIds: string[]; mergeId?: string }) =>
      api.post<MachineUnmergeResponse>('/source-documents/machine-unmerge', body),
    onSuccess: (res) => invalidate(res.documentIds),
  });
}
