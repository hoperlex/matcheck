import { Alert } from 'antd';
import dayjs from 'dayjs';
import type { SourceDocumentDetail, SourceDuplicateOperation } from '@matcheck/contracts';

/** «приёмка №24827 (Подтверждена МОЛ)» — для следа решения и окна дубликата. */
export function operationLabel(op: SourceDuplicateOperation): string {
  const kind = op.kind === 'delivery' ? 'приёмка' : 'отгрузка';
  const parts = [op.statusLabel, op.at ? dayjs(op.at).format('DD.MM.YYYY') : null].filter(
    Boolean,
  );
  const tail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${kind} №${op.displayId}${tail}${op.pendingDeletion ? ' — в корзине' : ''}`;
}

function at(v: string): string {
  const d = dayjs(v);
  return d.isValid() ? d.format('DD.MM.YYYY HH:mm') : '—';
}

/**
 * Дубликаты в карточке документа: «эта копия оставлена как новая поставка» и
 * «у этого документа есть оставленные копии». Второе — тревога, если сам
 * документ не принят: тогда на планшете две карточки одного документа.
 */
export function DuplicateTrailAlerts({ sd }: { sd: SourceDocumentDetail }) {
  const trail = sd.duplicateTrail;
  if (!trail) return null;
  const r = trail.resolution;
  const copies = trail.keptCopies;
  const twoCards = copies.length > 0 && !trail.selfAccepted && sd.status === 'parsed';

  return (
    <>
      {r && (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="Оставлена как новая поставка"
          description={
            <>
              <div>
                {r.userName ?? 'Пользователь не указан'}, {at(r.at)}
              </div>
              <div>
                Такой же документ{r.existingDocNumber ? ` №${r.existingDocNumber}` : ''}:{' '}
                {r.operations.length > 0
                  ? r.operations.map(operationLabel).join('; ')
                  : 'в операциях не участвовал'}
              </div>
              {r.comment ? <div>Комментарий: {r.comment}</div> : null}
            </>
          }
        />
      )}
      {copies.length > 0 && (
        <Alert
          style={{ marginBottom: 12 }}
          type={twoCards ? 'warning' : 'info'}
          showIcon
          message={
            twoCards
              ? 'На планшете могут быть две карточки этого документа'
              : 'У этого документа есть копии, оставленные как новые поставки'
          }
          description={
            <>
              {copies.map((c) => (
                <div key={c.id}>
                  №{c.docNumber ?? '—'}
                  {c.expectedDate ? ` на ${dayjs(c.expectedDate).format('DD.MM.YYYY')}` : ''}
                  {c.siteName ? ` (${c.siteName})` : ''} — {c.userName ?? 'пользователь не указан'}
                  {c.at ? `, ${at(c.at)}` : ''}
                </div>
              ))}
              {twoCards && (
                <div>
                  Этот документ ещё не принят. Если вторая машина не ожидается, удалите лишнюю
                  копию.
                </div>
              )}
            </>
          }
        />
      )}
    </>
  );
}
