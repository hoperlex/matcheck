import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Modal, Spin, message } from 'antd';
import type { DeliveryGroupMembersResponse } from '@matcheck/contracts';
import { api } from '../../services/api';
import { BulkEdoLinkFlow } from './BulkEdoLinkFlow';
import { bulkEdoLinkBlock } from './bulkEdoLinkBlock';

/**
 * «Привязать УПД из ЭДО» в строке группы: одна УПД — ко всем приёмкам группы.
 *
 * Состав берётся с сервера целиком, а не со страницы списка: часть группы может
 * быть на соседней странице или скрыта фильтром. Если состав пришёл неполным,
 * привязка не начинается. Дальше — привычный поток (подбор УПД, затем «К другим
 * приёмкам»), только участники группы там не снимаются, а сервер сверяет
 * состав в момент привязки и откажет, если он успел измениться.
 */
export function GroupEdoLinkFlow({
  groupId,
  onClose,
  onDone,
}: {
  /** Группа, к которой привязываем; null — окно закрыто. */
  groupId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const open = groupId !== null;
  const members = useQuery({
    queryKey: ['delivery-group-members', groupId],
    queryFn: () => api.get<DeliveryGroupMembersResponse>(`/delivery-groups/${groupId}/members`),
    enabled: open,
    // Состав мог измениться у другого менеджера: свежий при каждом открытии.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  // Снимок состава на время потока: перечитка запроса посреди подбора УПД не
  // должна закрывать окна. Устаревший снимок поймает сервер (group_changed).
  const [snapshot, setSnapshot] = useState<DeliveryGroupMembersResponse | null>(null);
  useEffect(() => {
    if (!open) setSnapshot(null);
  }, [open]);

  const data = members.data;
  const fresh = open && !members.isFetching && !!data && data.groupId === groupId;
  const incomplete = fresh && data.items.length !== data.memberIds.length;
  useEffect(() => {
    if (!fresh || incomplete || snapshot) return;
    const block = bulkEdoLinkBlock(data.items);
    if (block) {
      message.warning(block);
      onClose();
      return;
    }
    setSnapshot(data);
    // onClose — колбэк родителя; снимок берётся один раз за открытие.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, incomplete, snapshot, data]);

  return (
    <>
      <Modal
        open={open && !snapshot}
        title="Привязать УПД из ЭДО к группе"
        footer={null}
        onCancel={onClose}
        destroyOnClose
      >
        {members.isError ? (
          <Alert
            type="error"
            showIcon
            message={
              members.error instanceof Error
                ? members.error.message
                : 'Не удалось загрузить состав группы'
            }
          />
        ) : incomplete ? (
          <Alert
            type="error"
            showIcon
            message="Не удалось загрузить состав группы целиком — обновите список и попробуйте снова"
          />
        ) : (
          <Spin tip="Загружаем состав группы…">
            <div style={{ minHeight: 48 }} />
          </Spin>
        )}
      </Modal>
      {open && snapshot && (
        <BulkEdoLinkFlow
          open
          deliveries={snapshot.items}
          deliveryGroup={{ id: snapshot.groupId, memberIds: snapshot.memberIds }}
          onClose={onClose}
          onDone={onDone}
        />
      )}
    </>
  );
}
