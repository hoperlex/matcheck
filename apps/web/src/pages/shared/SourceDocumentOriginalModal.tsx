import { Alert, Button, Empty, Modal, Skeleton, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { SourceDocumentDetail } from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { DocumentOriginalViewer } from './DocumentOriginalViewer';
import { SourceDocumentItemsTable } from './SourceDocumentItemsTable';
import { sourceKindLabel } from '../../shared/utils/sourceKindLabel';

/**
 * Оригинал документа рядом с распознанными позициями — окно поверх карточки
 * операции.
 *
 * Зачем: в приёмке был виден только номер документа, а сама бумага лежала в
 * разделе «Документы». Чтобы сверить строку глазами, менеджер уходил искать
 * карточку руками — а у части ролей этого раздела нет вовсе.
 *
 * Отдельного маршрута API не заводим: `GET /source-documents/:id` уже открыт
 * правом «Операции: просмотр» и возвращает и вложения, и позиции. Ключ
 * react-query общий с разделом «Документы» — карточка, открытая там, здесь
 * уже прогрета.
 */
export function SourceDocumentOriginalModal({
  documentId,
  open,
  onClose,
  afterClose,
}: {
  /**
   * null — документ ещё не выбран. Данные и видимость намеренно разделены:
   * обнулять id одновременно с закрытием нельзя, иначе rc-dialog размонтирует
   * содержимое без перехода open true→false и afterClose не отработает.
   */
  documentId: string | null;
  open: boolean;
  onClose: () => void;
  afterClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['source-document', documentId],
    queryFn: () => api.get<SourceDocumentDetail>(`/source-documents/${documentId}`),
    enabled: open && documentId != null,
  });

  const sd = detail.data;
  // role='extracted_text' — служебный текстовый слепок, не бумага.
  const attachments = (sd?.attachments ?? []).filter((a) => a.role === 'original');
  const title = sd
    ? `Оригинал · ${sourceKindLabel(sd.kind)} ${sd.docNumber ?? '— без номера —'}`
    : 'Оригинал документа';

  return (
    <Modal
      open={open}
      onCancel={onClose}
      afterClose={afterClose}
      title={title}
      width="92vw"
      style={{ top: 16, paddingBottom: 0, maxWidth: 'none' }}
      styles={{
        // Высота задаётся здесь, а не содержимым: просмотрщик в режиме
        // compact тянется на height:100% и без родителя с высотой схлопнулся
        // бы к минимуму, а длинная таблица позиций растянула бы окно.
        body: {
          padding: '12px 16px',
          height: 'calc(100vh - 120px)',
          overflow: 'hidden',
        },
      }}
      footer={null}
      destroyOnHidden
    >
      <ModalBody
        documentId={documentId}
        detail={detail}
        sd={sd}
        attachments={attachments}
      />
    </Modal>
  );
}

function ModalBody({
  documentId,
  detail,
  sd,
  attachments,
}: {
  documentId: string | null;
  detail: ReturnType<typeof useQuery<SourceDocumentDetail>>;
  sd: SourceDocumentDetail | undefined;
  attachments: SourceDocumentDetail['attachments'];
}) {
  if (detail.isPending) return <Skeleton active paragraph={{ rows: 8 }} />;

  if (detail.isError) {
    const err = detail.error;
    // 404 приходит и на «нет такого документа», и на «этот документ вам не
    // виден» (см. sourceDocumentVisible) — для человека это одно и то же.
    const denied = err instanceof ApiError && (err.status === 404 || err.status === 403);
    if (denied) {
      return (
        <Alert
          type="warning"
          showIcon
          message="Документ недоступен"
          description="Он удалён или закрыт для вашей роли."
        />
      );
    }
    return (
      <Alert
        type="error"
        showIcon
        message="Не удалось загрузить документ"
        description={err instanceof Error ? err.message : 'Неизвестная ошибка'}
        action={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void detail.refetch()}>
            Повторить
          </Button>
        }
      />
    );
  }

  if (!sd || !documentId) return null;

  return (
    <div style={{ display: 'flex', gap: 12, height: '100%', minHeight: 0 }}>
      <div style={{ flex: '1 1 60%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {attachments.length > 0 ? (
          <DocumentOriginalViewer attachments={attachments} id={documentId} compact showDownload />
        ) : (
          // Отдельно от «Документ недоступен»: карточка открылась, просто
          // файла у неё нет (документ из ЭДО приходит XML-строкой, оригинала
          // в хранилище не оставляет).
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Оригинал файла недоступен"
            style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}
          />
        )}
      </div>
      <div style={{ flex: '1 1 40%', minWidth: 0, minHeight: 0, overflow: 'auto' }}>
        <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
          Позиции документа ({sd.items.length})
        </Typography.Text>
        <SourceDocumentItemsTable
          items={sd.items}
          showInvNumber={sd.kind === 'os2_transfer'}
          withVat={sd.kind === 'upd'}
          docTotalSum={sd.totalSum}
          docVatSum={sd.vatSum}
        />
      </div>
    </div>
  );
}
