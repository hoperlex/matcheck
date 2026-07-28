import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Input, Space, Tooltip, Typography, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  COMMENT_RAW_MAX,
  COMMENT_SLOT_MAX,
  parseOperationComment,
  type Delivery,
  type Shipment,
} from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { runExclusive } from '../../services/syncLock';
import { reconcileServerSnapshot as reconcileDelivery } from '../../services/deliveries';
import { reconcileServerSnapshot as reconcileShipment } from '../../services/shipments';

/**
 * Блок «Комментарий» карточки приёмки/отгрузки — общий для KppPage и ShipmentPage.
 *
 * Мобильный клиент пакует три части («1 Этап», «2 Этап», «Примечание») в одну
 * строку канонического формата, веб её разбирает и показывает секциями. Здесь
 * добавляется правка: клик по значению → поле → «Сохранить комментарий».
 *
 * Доступ: admin/manager и только «Подтверждено МОЛ» (операция завершена; сюда же
 * попадает ручной внос/вынос, который мобила создаёт сразу подтверждённым).
 * Пока правка недоступна, блок выглядит ровно как раньше — без карандашей,
 * подсказок и приглушённых кнопок.
 *
 * Три режима тела:
 *   • слоты   — строка разбирается по этапам без потерь (isCanonical). PATCH
 *               шлёт только изменённые слоты, сервер мержит их в текущее
 *               значение: правка «Примечания» не откатывает «2 Этап», который
 *               мобила дописала минуту назад.
 *   • raw     — строка есть, но без потерь не разбирается (legacy-хвост, лишние
 *               пробелы) ЛИБО маркеров нет вовсе. Правится целиком, байт-в-байт.
 *   • read-only — прав нет или документ ещё не подтверждён.
 *
 * ВАЖНО: отображение (секции vs единый текст) определяется hasStructure, а
 * редактирование — isCanonical. Иначе legacy-комментарий с маркерами внезапно
 * перестал бы показываться секциями.
 */

const EDIT_ROLES = new Set(['admin', 'manager']);

type Slot = 'stage1' | 'stage2' | 'note';
const SLOTS: Slot[] = ['stage1', 'stage2', 'note'];
const SLOT_LABEL: Record<Slot, string> = {
  stage1: '1 Этап',
  stage2: '2 Этап',
  note: 'Примечание (номер УПД)',
};

type Drafts = Record<Slot, string>;
const EMPTY_DRAFTS: Drafts = { stage1: '', stage2: '', note: '' };

export function OperationCommentSection({
  entityType,
  id,
  statusCode,
  isNew,
  isContractor,
  serverComment,
  rawValue,
  onRawChange,
  onRawDirtyChange,
  pendingDeletion,
  externalSaving,
  onPendingChange,
  onSaved,
}: {
  entityType: 'delivery' | 'shipment';
  id: string;
  statusCode: string;
  /** Документа ещё нет на сервере — PATCH дал бы 404, правка идёт футером. */
  isNew: boolean;
  isContractor: boolean;
  serverComment: string | null;
  /** Стейт `comment` страницы: единственный источник правды для raw-режима. */
  rawValue: string;
  onRawChange: (value: string) => void;
  /** Пока true, страница не должна гидратировать поле комментария из refetch. */
  onRawDirtyChange?: (dirty: boolean) => void;
  pendingDeletion: boolean;
  /** Идёт футерное сохранение — свои кнопки блокируем, чтобы не переплетать пути записи. */
  externalSaving: boolean;
  onPendingChange?: (pending: boolean) => void;
  onSaved: (dto: Delivery | Shipment) => void | Promise<void>;
}) {
  const role = useAuthStore((s) => s.user?.role);
  const qc = useQueryClient();

  const canPatch =
    role != null &&
    EDIT_ROLES.has(role) &&
    statusCode === 'confirmed_mol' &&
    !isNew &&
    !pendingDeletion;

  const parsed = parseOperationComment(serverComment);
  const listKey = entityType === 'delivery' ? 'deliveries' : 'shipments';

  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>(EMPTY_DRAFTS);
  const [dirtySlots, setDirtySlots] = useState<Set<Slot>>(new Set());
  const [focusSlot, setFocusSlot] = useState<Slot | null>(null);
  const [rawDirty, setRawDirty] = useState(false);
  const [conflict, setConflict] = useState<{ message: string; currentComment: string | null } | null>(
    null,
  );

  const slotValue = useCallback(
    (slot: Slot): string => {
      const v = slot === 'stage1' ? parsed.stage1 : slot === 'stage2' ? parsed.stage2 : parsed.note;
      return v ?? '';
    },
    [parsed.stage1, parsed.stage2, parsed.note],
  );

  // Карточка поллится раз в 5 секунд. Обновляем драфты ТОЛЬКО нетронутых слотов:
  // сравнивать драфт со свежим сервером нельзя (правка инспектора пометила бы
  // чужой слот «изменённым» и портал отправил бы его обратно), а переинициализация
  // всех слотов стёрла бы ввод менеджера.
  useEffect(() => {
    if (!editing) return;
    setDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const slot of SLOTS) {
        if (dirtySlots.has(slot)) continue;
        const fresh = slotValue(slot);
        if (next[slot] !== fresh) {
          next[slot] = fresh;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [editing, dirtySlots, slotValue]);

  const notifyRawDirty = useRef(onRawDirtyChange);
  notifyRawDirty.current = onRawDirtyChange;
  useEffect(() => {
    notifyRawDirty.current?.(rawDirty);
  }, [rawDirty]);

  const notifyPending = useRef(onPendingChange);
  notifyPending.current = onPendingChange;

  const mutation = useMutation({
    mutationFn: async (body: Record<string, string | null>) =>
      // Лок держим на ВСЮ цепочку, а не только на HTTP: между ответом сервера и
      // записью в IndexedDB фоновый sync успел бы отправить payload из очереди
      // со старым комментарием и затереть правку.
      runExclusive(async () => {
        await qc.cancelQueries({ queryKey: [listKey, id], exact: true });
        const dto = await api.patch<Delivery | Shipment>(`/${listKey}/${id}/comment`, body);
        if (entityType === 'delivery') await reconcileDelivery(dto as Delivery);
        else await reconcileShipment(dto as Shipment);
        await onSaved(dto);
        return dto;
      }),
    onSuccess: () => {
      message.success('Комментарий сохранён');
      setEditing(false);
      setDirtySlots(new Set());
      setRawDirty(false);
      setConflict(null);
      void qc.invalidateQueries({ queryKey: [listKey] });
    },
    onError: (err: Error) => {
      // Черновики НЕ сбрасываем ни в одной ветке — иначе набранный текст пропадёт.
      if (err instanceof ApiError && err.status === 409) {
        const payload = err.payload as { details?: { currentComment?: string | null } } | undefined;
        setConflict({
          message: err.message,
          currentComment: payload?.details?.currentComment ?? serverComment,
        });
        return;
      }
      message.error(err.message);
    },
  });

  useEffect(() => {
    notifyPending.current?.(mutation.isPending);
  }, [mutation.isPending]);

  const startEditing = (slot: Slot) => {
    if (!canPatch || editing) return;
    setDrafts({ stage1: slotValue('stage1'), stage2: slotValue('stage2'), note: slotValue('note') });
    setDirtySlots(new Set());
    setFocusSlot(slot);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setDrafts(EMPTY_DRAFTS);
    setDirtySlots(new Set());
    setConflict(null);
  };

  const changeSlot = (slot: Slot, value: string) => {
    setDrafts((prev) => ({ ...prev, [slot]: value }));
    setDirtySlots((prev) => (prev.has(slot) ? prev : new Set(prev).add(slot)));
  };

  const saveSlots = () => {
    const body: Record<string, string | null> = {};
    for (const slot of dirtySlots) body[slot] = drafts[slot].trim().length > 0 ? drafts[slot] : null;
    if (Object.keys(body).length === 0) return;
    mutation.mutate(body);
  };

  const changeRaw = (value: string) => {
    onRawChange(value);
    if (canPatch) setRawDirty(true);
  };

  const cancelRaw = () => {
    onRawChange(serverComment ?? '');
    setRawDirty(false);
    setConflict(null);
  };

  const saveRaw = () => mutation.mutate({ comment: rawValue.trim().length > 0 ? rawValue : null });

  const busy = mutation.isPending || externalSaving;
  const empty = <Typography.Text type="secondary">— нет —</Typography.Text>;

  const conflictAlert = conflict ? (
    <Alert
      type="warning"
      showIcon
      message={conflict.message}
      description={
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Typography.Text type="secondary">Текущее значение на сервере:</Typography.Text>
          <Typography.Paragraph
            copyable
            style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}
          >
            {conflict.currentComment ?? '— пусто —'}
          </Typography.Paragraph>
          <Space size={8}>
            <Button
              size="small"
              onClick={() => {
                // Переносим свежую строку в поле «текстом целиком»; введённое
                // остаётся на экране до этого момента, чтобы можно было скопировать.
                onRawChange(conflict.currentComment ?? '');
                setEditing(false);
                setDirtySlots(new Set());
                setRawDirty(false);
                setConflict(null);
              }}
            >
              Открыть как текст
            </Button>
            <Button size="small" type="text" onClick={() => setConflict(null)}>
              Закрыть
            </Button>
          </Space>
        </Space>
      }
    />
  ) : null;

  const editButtons = (onSave: () => void, onCancel: () => void, disabled: boolean) => (
    <Space size={8}>
      <Button size="small" type="primary" loading={mutation.isPending} disabled={disabled} onClick={onSave}>
        Сохранить комментарий
      </Button>
      <Button size="small" type="text" disabled={mutation.isPending} onClick={onCancel}>
        Отмена
      </Button>
    </Space>
  );

  // ── Раскладка тела ───────────────────────────────────────────────────────
  let body: React.ReactNode;

  if (parsed.hasStructure && editing && parsed.isCanonical) {
    body = (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {conflictAlert}
        {SLOTS.map((slot) => (
          <div key={slot}>
            <Typography.Text strong>{SLOT_LABEL[slot]}</Typography.Text>
            {slot === 'note' && (
              <Tooltip title="Мобильное приложение показывает это как заголовок карточки, если УПД не привязана">
                <Typography.Text type="secondary"> ⓘ</Typography.Text>
              </Tooltip>
            )}
            <Input.TextArea
              style={{ marginTop: 4 }}
              autoSize={{ minRows: 1, maxRows: 6 }}
              autoFocus={focusSlot === slot}
              maxLength={COMMENT_SLOT_MAX}
              value={drafts[slot]}
              disabled={busy}
              onChange={(e) => changeSlot(slot, e.target.value)}
            />
          </div>
        ))}
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          Переносы строк сохраняются как пробелы — формат общий с мобильным приложением.
        </Typography.Text>
        {editButtons(saveSlots, cancelEditing, busy || dirtySlots.size === 0)}
      </Space>
    );
  } else if (parsed.hasStructure && editing) {
    // Маркеры есть, но строка не разбирается без потерь — правим целиком.
    body = (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {conflictAlert}
        <Alert
          type="info"
          showIcon
          message="Этот комментарий не разбирается по этапам без потерь — правится текстом целиком"
        />
        <Input.TextArea
          rows={4}
          maxLength={COMMENT_RAW_MAX}
          value={rawValue}
          disabled={busy}
          onChange={(e) => changeRaw(e.target.value)}
        />
        {editButtons(
          saveRaw,
          () => {
            cancelRaw();
            cancelEditing();
          },
          busy,
        )}
      </Space>
    );
  } else if (parsed.hasStructure) {
    body = (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {conflictAlert}
        {SLOTS.map((slot) => {
          const value = slotValue(slot);
          // «Примечание» без значения раньше не показывалось вовсе; при
          // доступной правке показываем — иначе его нельзя было бы добавить.
          if (slot === 'note' && value.length === 0 && !canPatch) return null;
          return (
            <div key={slot}>
              <Typography.Text strong>{slot === 'note' ? 'Примечание' : SLOT_LABEL[slot]}</Typography.Text>
              <div
                style={{
                  marginTop: 4,
                  whiteSpace: 'pre-wrap',
                  ...(canPatch ? { cursor: 'text' } : {}),
                }}
                onClick={() => startEditing(slot)}
              >
                {value.length > 0 ? value : empty}
                {canPatch && (
                  <EditOutlined style={{ marginLeft: 8, opacity: 0.35, fontSize: 12 }} />
                )}
              </div>
            </div>
          );
        })}
      </Space>
    );
  } else {
    // Маркеров нет — единое поле, как и было. Правка доступна только при canPatch
    // (для нового документа — по старым правилам, текст уедет футером).
    const rawEditable = isNew ? !isContractor : canPatch;
    body = (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {conflictAlert}
        <Input.TextArea
          rows={3}
          maxLength={COMMENT_RAW_MAX}
          value={rawValue}
          disabled={!rawEditable || busy}
          onChange={(e) => changeRaw(e.target.value)}
        />
        {canPatch && rawDirty && editButtons(saveRaw, cancelRaw, busy)}
      </Space>
    );
  }

  return (
    <Collapse
      size="small"
      // Свёрнут по умолчанию, как и Фото — экономия места в Modal.
      defaultActiveKey={[]}
      items={[{ key: 'comment', label: 'Комментарий', children: body }]}
    />
  );
}
