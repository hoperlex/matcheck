import { Alert, Button, List, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import type { MachineMergeResponse, MachineMergeValueGroup } from '@matcheck/contracts';
import { ApiError } from '../../services/api';
import { formatDateRu } from '../../shared/utils/formatRu';
import { sourceKindLabel } from '../../shared/utils/sourceKindLabel';
import { documentsCount } from './machineGroupRows';
import { useMachineMergeMutation, useMachineMergePreview } from './useMachineMerge';

/** «ООО А, ООО Б»; поставщик без имени — «без названия». */
function supplierLabels(values: MachineMergeValueGroup[]): string {
  return values.map((v) => v.label ?? 'без названия').join(', ');
}

/**
 * «Объединить в одну машину»: предпросмотр итоговой карточки и подтверждение.
 *
 * Документы не меняются — меняется только то, что станет одной карточкой на
 * планшете. Окно показывает итог ДО действия, а запрос несёт состав, который
 * видел менеджер (expectedDocumentIds): если за это время он изменился (доехал
 * файл, другой менеджер успел объединить), сервер отвечает 409, и окно
 * перечитывает предпросмотр.
 */
export function MachineMergeModal({
  documentIds,
  onClose,
  onMerged,
}: {
  /** Выбранные документы; null — окно закрыто. */
  documentIds: string[] | null;
  onClose: () => void;
  onMerged: (res: MachineMergeResponse) => void;
}) {
  const preview = useMachineMergePreview(documentIds);
  const merge = useMachineMergeMutation();
  const data = preview.data;
  const blocked = !data || data.blockers.length > 0 || data.alreadyOneMachine;

  const submit = () => {
    if (!data || !documentIds) return;
    merge.mutate(
      { documentIds, expectedDocumentIds: data.documentIds },
      {
        onSuccess: (res) => onMerged(res),
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'composition_changed') {
            void message.warning('Состав изменился — проверьте ещё раз');
            void preview.refetch();
            return;
          }
          void message.error(err instanceof Error ? err.message : 'Не удалось объединить');
        },
      },
    );
  };

  return (
    <Modal
      open={!!documentIds}
      title="Объединить в одну машину"
      onCancel={onClose}
      destroyOnHidden
      width={720}
      centered
      footer={[
        <Button key="cancel" onClick={onClose} disabled={merge.isPending}>
          Отмена
        </Button>,
        <Button
          key="merge"
          type="primary"
          disabled={blocked}
          loading={merge.isPending}
          onClick={submit}
        >
          Объединить
        </Button>,
      ]}
    >
      {preview.isLoading && (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      )}
      {preview.isError && (
        <Alert
          type="error"
          showIcon
          message={
            preview.error instanceof Error
              ? preview.error.message
              : 'Не удалось построить предпросмотр'
          }
        />
      )}
      {data && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {data.alreadyOneMachine ? (
            <Alert type="info" showIcon message="Выбранные документы уже в одной машине" />
          ) : (
            <Typography.Text>
              На планшете будет <b>одна карточка</b>: {documentsCount(data.documentIds.length)}
              {data.siteName ? ` · ${data.siteName}` : ''}
              {data.expectedDate ? ` · поставка ${formatDateRu(data.expectedDate)}` : ''}
            </Typography.Text>
          )}
          {data.blockerMessages.length > 0 && (
            <Alert
              type="error"
              showIcon
              message="Объединить нельзя"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {data.blockerMessages.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              }
            />
          )}
          {data.warnings.map((w) =>
            w.code === 'documents_in_progress' ? (
              <Alert
                key={w.code}
                type="warning"
                showIcon
                message={`${documentsCount(w.count)} ещё распознаётся — машина появится на планшете целиком, когда разбор закончится`}
              />
            ) : w.code === 'different_suppliers' ? (
              <Alert
                key={w.code}
                type="warning"
                showIcon
                message={`Документы разных поставщиков: ${supplierLabels(w.values)}`}
                description="Как при загрузке одной отправкой: у каждого документа остаётся свой поставщик — позиции и выгрузка в 1С идут по документу. В шапке приёмки будет поставщик первого УПД."
              />
            ) : null,
          )}
          {!data.alreadyOneMachine && data.blockers.length === 0 && (
            <Alert
              type="info"
              showIcon
              message="Объединяйте до того, как инспектор начал оформлять одну из карточек: так на планшете сразу будет одна приёмка"
            />
          )}
          <List
            size="small"
            bordered
            dataSource={data.machines}
            renderItem={(m, index) => (
              <List.Item style={{ display: 'block' }}>
                <Space size={8} style={{ marginBottom: 4 }}>
                  <Typography.Text strong>Отправка {index + 1}</Typography.Text>
                  <Typography.Text type="secondary">
                    {m.uploads[0] ? `загружена ${formatDateRu(m.uploads[0].uploadedAt)}` : ''}
                  </Typography.Text>
                  {m.merged && <Tag>уже объединена из {m.uploads.length}</Tag>}
                  {m.headId === data.targetHeadId && !data.alreadyOneMachine && (
                    <Tag color="blue">главная</Tag>
                  )}
                </Space>
                {m.documents.map((d) => (
                  <div key={d.id} style={{ paddingLeft: 12 }}>
                    <Typography.Text>
                      {sourceKindLabel(d.kind as never)} {d.docNumber ?? 'без номера'}
                    </Typography.Text>
                    {d.supplierName && (
                      <Typography.Text type="secondary"> · {d.supplierName}</Typography.Text>
                    )}
                  </div>
                ))}
              </List.Item>
            )}
          />
        </Space>
      )}
    </Modal>
  );
}
