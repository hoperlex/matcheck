import { useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SourceDocumentDetail,
  SourceDuplicateInfo,
  SourceDuplicateSibling,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { operationLabel } from './DuplicateTrailAlerts';

type Action = 'skip' | 'replace' | 'keep';

const MISSING_LABELS: Record<string, string> = {
  docNumber: 'номер документа',
  items: 'материалы',
  itemsIncomplete: 'не все позиции (по бланку строк больше)',
};

function fmtDate(v: string | null | undefined): string {
  return v ? dayjs(v).format('DD.MM.YYYY') : '—';
}

function SiblingLine({ s }: { s: SourceDuplicateSibling }) {
  const live = s.operations.filter((op) => !op.pendingDeletion);
  return (
    <div style={{ marginBottom: 4 }}>
      <Space size={4} wrap>
        <Typography.Text strong>№{s.docNumber ?? '—'}</Typography.Text>
        <span>
          поставка {fmtDate(s.expectedDate)}
          {s.siteName ? `, ${s.siteName}` : ''}
        </span>
        {s.isExisting && <Tag style={{ marginInlineEnd: 0 }}>найден при загрузке</Tag>}
        {s.accepted ? (
          <Tag color="green" style={{ marginInlineEnd: 0 }}>
            принят
          </Tag>
        ) : (
          <Tag color="orange" style={{ marginInlineEnd: 0 }}>
            не принят — карточка на планшете
          </Tag>
        )}
        {s.edoLinks > 0 && live.length === 0 && (
          <Tag style={{ marginInlineEnd: 0 }}>связан только с ЭДО</Tag>
        )}
      </Space>
      {s.operations.length > 0 && (
        <div style={{ color: 'rgba(0,0,0,0.65)' }}>
          {s.operations.map(operationLabel).join('; ')}
        </div>
      )}
    </div>
  );
}

/**
 * Окно решения по копии-дубликату. Открывается из списка «Документы» по ссылке
 * «разрешить» и из карточки копии кнопкой «Оставить как новую поставку…».
 *
 * Действия:
 *   * «Изменить копию» — карточка копии; правки сохраняются, на планшет копия
 *     не уходит;
 *   * «Оставить как новую поставку» — копия уходит на планшет. Сервер пускает,
 *     только если такой же документ уже принят: тогда его карточки на планшете
 *     нет и останется одна (правило в api duplicate-keep.ts);
 *   * «Заменить» — удалить найденный документ и распознать копию заново;
 *   * «Удалить копию».
 * Кнопки рисуются по ответу duplicate-info, а сервер при нажатии считает то же
 * самое теми же функциями.
 */
export function UpdResolveDuplicateModal({
  id,
  open,
  onClose,
  onOpenDocument,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
  /** Открыть карточку документа (копии) вместо этого окна. */
  onOpenDocument?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [comment, setComment] = useState('');

  const info = useQuery({
    queryKey: ['source-document-duplicate-info', id],
    queryFn: () => api.get<SourceDuplicateInfo>(`/source-documents/${id}/duplicate-info`),
    enabled: !!id && open,
  });

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['source-documents'] });
    await qc.invalidateQueries({ queryKey: ['source-document', id] });
    await qc.invalidateQueries({ queryKey: ['source-document-offline', id] });
    await qc.invalidateQueries({ queryKey: ['source-document-duplicate-info', id] });
  };

  const close = () => {
    setAction(null);
    setComment('');
    onClose();
  };

  const resolve = useMutation({
    mutationFn: (a: Action) =>
      api.post<{ ok: true } | SourceDocumentDetail>(`/source-documents/${id}/resolve-duplicate`, {
        action: a,
        ...(a === 'keep' && comment.trim() ? { comment: comment.trim() } : {}),
      }),
    onSuccess: async (res, a) => {
      if (a === 'skip') message.success('Копия удалена');
      else if (a === 'replace') message.success('Найденный документ удалён, копия распознаётся заново');
      else {
        const doc = res as SourceDocumentDetail;
        if (doc.status === 'parsed') {
          message.success(
            doc.expectedDate && doc.siteId
              ? `Копия оставлена — уйдёт на планшет на ${fmtDate(doc.expectedDate)}`
              : 'Копия оставлена. Укажите в карточке объект и дату поставки — без них на планшет она не уйдёт',
          );
        } else {
          message.warning('Копия оставлена, но распознана не полностью — дополните её в карточке');
        }
      }
      await invalidate();
      close();
    },
    onError: async (err: Error) => {
      message.error(err.message);
      // Состояние могло измениться (вторая вкладка, приёмку отвязали) —
      // показываем актуальное.
      await qc.invalidateQueries({ queryKey: ['source-document-duplicate-info', id] });
    },
  });

  const d = info.data;
  const liveOps = (d?.siblings ?? [])
    .flatMap((s) => s.operations)
    .filter((op) => !op.pendingDeletion);
  const keepConfirm =
    liveOps.length > 0
      ? `По этому документу уже ${liveOps.length > 1 ? 'приняты' : 'принята'} ${liveOps
          .map(operationLabel)
          .join('; ')}. Оформить ещё одну поставку по этой копии?`
      : 'Оставить копию как отдельный документ? Она уйдёт на планшет.';
  const missingText = (d?.keep.missing ?? []).map((m) => MISSING_LABELS[m] ?? m).join(', ');
  const busy = resolve.isPending;

  return (
    <Modal
      open={open}
      title="Дубликат документа"
      onCancel={() => {
        if (!busy) close();
      }}
      footer={null}
      width={640}
      maskClosable={false}
      keyboard={false}
      destroyOnClose
    >
      {info.isLoading && (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      )}
      {info.error && (
        <Alert
          type="error"
          showIcon
          message="Не удалось загрузить сведения о дубликате"
          description={(info.error as Error).message}
        />
      )}
      {d && (
        <>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="В системе уже есть документ с теми же реквизитами"
            description={
              d.duplicateCheck?.detail
                ? `Проверка содержимого: ${d.duplicateCheck.detail}.`
                : 'Выберите, что сделать с этой копией.'
            }
          />
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
            <Descriptions.Item label="Поставщик">{d.supplierName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="№ документа">{d.docNumber ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Дата документа">{fmtDate(d.docDate)}</Descriptions.Item>
            <Descriptions.Item label="Копия: поставка">
              {fmtDate(d.expectedDate)}
              {d.siteName ? `, ${d.siteName}` : ''}
            </Descriptions.Item>
          </Descriptions>

          <Typography.Text strong>Такой же документ в системе</Typography.Text>
          <div style={{ margin: '4px 0 12px' }}>
            {d.siblings.length === 0 ? (
              <Typography.Text type="secondary">
                {d.existingMissing
                  ? 'Найденный ранее документ уже удалён.'
                  : 'Других документов с этими реквизитами в работе нет.'}
              </Typography.Text>
            ) : (
              d.siblings.map((s) => <SiblingLine key={s.id} s={s} />)
            )}
          </div>

          <Space direction="vertical" style={{ width: '100%' }}>
            {onOpenDocument && (
              <Button block disabled={busy} onClick={() => onOpenDocument(d.id)}>
                Изменить копию (дата поставки, количества, позиции)
              </Button>
            )}

            <Input.TextArea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={500}
              autoSize={{ minRows: 1, maxRows: 3 }}
              placeholder="Комментарий, необязательно: например, вторая машина по той же накладной"
              disabled={busy || !d.keep.allowed}
            />
            <Popconfirm
              title="Оставить как новую поставку?"
              description={<div style={{ maxWidth: 360 }}>{keepConfirm}</div>}
              okText="Оставить"
              cancelText="Отмена"
              disabled={busy || !d.keep.allowed}
              onConfirm={() => {
                setAction('keep');
                resolve.mutate('keep');
              }}
            >
              <Button
                type="primary"
                block
                loading={busy && action === 'keep'}
                disabled={busy || !d.keep.allowed}
              >
                Оставить как новую поставку
              </Button>
            </Popconfirm>
            {!d.keep.allowed && d.keep.message && (
              <Typography.Text type="secondary">
                {d.keep.message}
                {missingText ? ` Не хватает: ${missingText}.` : ''}
              </Typography.Text>
            )}

            <Button
              block
              loading={busy && action === 'replace'}
              disabled={busy || !d.replace.allowed}
              onClick={() => {
                setAction('replace');
                resolve.mutate('replace');
              }}
            >
              Заменить (удалить найденный, распознать копию заново)
            </Button>
            {!d.replace.allowed && (
              <Typography.Text type="secondary">
                {d.replace.reason === 'original_used'
                  ? 'Найденный документ уже используется в приёмке, отгрузке или ЭДО — заменить его нельзя.'
                  : 'Нет ссылки на найденный документ — заменить нечего.'}
              </Typography.Text>
            )}

            <Button
              danger
              block
              loading={busy && action === 'skip'}
              disabled={busy}
              onClick={() => {
                setAction('skip');
                resolve.mutate('skip');
              }}
            >
              Удалить копию
            </Button>
          </Space>
        </>
      )}
    </Modal>
  );
}
