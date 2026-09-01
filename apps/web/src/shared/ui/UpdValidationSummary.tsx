import { useState, type JSX } from 'react';
import { Alert, Button, Space } from 'antd';
import { DownOutlined, UpOutlined } from '@ant-design/icons';
import type { UpdCheck, UpdWarning } from '@matcheck/contracts';
import { formatMoneyRu } from '../utils/formatRu';

/**
 * Сверка сумм, как её читает менеджер, — общая для карточки документа и для
 * фото-документа в Принятых.
 *
 * Раньше тексты жили внутри карточки документа. Фото разбирается тем же
 * валидатором (домен photos/recognize-upd.ts), и вторая копия описаний
 * означала бы, что одно и то же расхождение объясняется в двух местах
 * по-разному — ровно та беда, из-за которой у фото и появился свой промпт.
 */

export function describeCheck(c: UpdCheck): string {
  const where = c.scope === 'document' ? 'по документу' : `строка ${c.scope.row}`;
  const name =
    {
      sum_total: 'сумма позиций vs итог документа',
      vat_total: 'НДС позиций vs НДС документа',
      items_count: 'количество позиций vs «Всего наименований»',
      items_sequence: 'номера позиций идут не подряд — строка потеряна или задвоена',
      row_qty_price: 'qty × price ≠ sum',
      row_vat_rate: 'sum × ставка ≠ НДС',
    }[c.name] || c.name;
  const exp = c.expected != null ? c.expected.toFixed(2) : '—';
  const act = c.actual != null ? c.actual.toFixed(2) : '—';
  return `${name} (${where}): ожидается ${exp}, по факту ${act}${explainGap(c)}`;
}

/**
 * Что расхождение значит на практике: не хватает строки или строка задвоилась.
 *
 * Само по себе «ожидается 2 557 288, по факту 1 513 703» требует от менеджера
 * вычесть одно из другого и догадаться, что за этим стоит. Знак разницы говорит
 * прямо: меньше итога — позицию потеряли при распознавании, больше — задвоили.
 *
 * Направление считается как actual − expected, а НЕ берётся из поля `diff`:
 * оно беззнаковое, валидатор пишет туда Math.abs (см. upd-validation.ts).
 */
export function explainGap(c: UpdCheck): string {
  if (c.scope !== 'document') return '';
  if (c.name !== 'sum_total' && c.name !== 'vat_total') return '';
  if (c.expected == null || c.actual == null) return '';
  const gap = c.actual - c.expected;
  if (gap === 0) return '';
  const amount = formatMoneyRu(Math.abs(gap));
  return gap < 0
    ? ` — не хватает ${amount}, вероятно, строка не распозналась`
    : ` — лишние ${amount}, вероятно, строка задвоилась`;
}

/**
 * Подозрения читаются иначе, чем расхождения: арифметика сошлась, доказательства
 * нет — есть только повод перепроверить строку глазами по бумаге.
 */
export function describeWarning(w: UpdWarning): string {
  const where = w.scope === 'document' ? 'по документу' : `строка ${w.scope.row}`;
  const name =
    {
      qty_price_swap: 'похоже, количество и цена стоят не в своих колонках',
      unit_code_as_qty: 'в количестве стоит код единицы измерения из бланка, а не количество',
      sum_equals_qty: 'сумма совпадает с количеством — похоже, в бумаге цены нет',
      unit_price_one: 'цена ровно 1 — проверьте, напечатана ли она в документе',
      price_includes_vat:
        'цена взята с НДС: количество × цена дало стоимость с налогом вместо графы 4',
      consignee_copy_unverified:
        'грузополучатель совпал с покупателем, но в графе 4 напечатано другое',
      duplicate_unconfirmed:
        'реквизиты совпали с другим документом, но совпадение содержимого не подтверждено — дубликатом не считаем',
    }[w.name] || w.name;
  return `${name} (${where})`;
}

/**
 * Порог автосворачивания: до трёх пунктов включительно список занимает пару
 * строк и прятать его незачем — расхождение должно бросаться в глаза само.
 */
const VALIDATION_AUTO_COLLAPSE_OVER = 3;

/** Ключ по умолчанию — тот же, что был у карточки документа до выноса. */
export const VALIDATION_LS_KEY = 'matcheck.docModal.validation';

function readValidationOpen(total: number, storageKey: string): boolean {
  try {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem(storageKey);
      // Явный выбор пользователя сильнее автопорога: кому нужны детали на
      // каждом документе, тот не должен кликать «Показать» в каждой карточке.
      if (v === 'expanded') return true;
      if (v === 'collapsed') return false;
    }
  } catch {
    // localStorage может быть недоступен (privacy mode) — молча игнорируем.
  }
  return total <= VALIDATION_AUTO_COLLAPSE_OVER;
}

/**
 * Перечень растёт по пункту на каждую проблемную строку: у УПД на девять
 * позиций, где цена взята с НДС, набегает два десятка пунктов. Статичным
 * списком они занимали всю высоту модалки, и остальное схлопывалось почти в
 * ноль. Поэтому список сворачивается в одну полосу со счётчиками.
 */
export function UpdValidationSummary({
  failedChecks,
  warnings,
  storageKey = VALIDATION_LS_KEY,
}: {
  failedChecks: UpdCheck[];
  warnings: UpdWarning[];
  /** Своё состояние «развёрнуто/свёрнуто» для каждого места показа. */
  storageKey?: string;
}): JSX.Element | null {
  const total = failedChecks.length + warnings.length;
  const [open, setOpen] = useState<boolean>(() => readValidationOpen(total, storageKey));

  function toggle(next: boolean) {
    setOpen(next);
    try {
      window.localStorage.setItem(storageKey, next ? 'expanded' : 'collapsed');
    } catch {
      // localStorage может быть недоступен (privacy mode) — молча игнорируем.
    }
  }

  if (total === 0) return null;

  if (!open) {
    return (
      <Alert
        type={failedChecks.length > 0 ? 'warning' : 'info'}
        showIcon
        // Счётчик показываем только у непустой группы: «Расхождения: 0» —
        // ложная тревога на пустом месте.
        message={
          <Space size={8} wrap>
            {failedChecks.length > 0 && <span>Расхождения в суммах: {failedChecks.length}</span>}
            {warnings.length > 0 && <span>Проверьте строки: {warnings.length}</span>}
          </Space>
        }
        action={
          <Button type="link" size="small" icon={<DownOutlined />} onClick={() => toggle(true)}>
            Показать
          </Button>
        }
      />
    );
  }

  // Кнопка «Свернуть» — в ПЕРВОМ отрисованном блоке: при пустых checks это блок
  // подозрений, иначе свернуть список было бы нечем.
  const collapseButton = (
    <Button type="link" size="small" icon={<UpOutlined />} onClick={() => toggle(false)}>
      Свернуть
    </Button>
  );

  return (
    <>
      {failedChecks.length > 0 && (
        <Alert
          style={{ marginBottom: warnings.length > 0 ? 12 : 0 }}
          type="warning"
          showIcon
          message="Расхождения в суммах"
          action={collapseButton}
          description={
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {failedChecks.map((c, i) => (
                <li key={i}>{describeCheck(c)}</li>
              ))}
            </ul>
          }
        />
      )}
      {warnings.length > 0 && (
        <Alert
          type="info"
          showIcon
          message="Проверьте строки по документу"
          action={failedChecks.length === 0 ? collapseButton : undefined}
          description={
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {warnings.map((w, i) => (
                <li key={i}>{describeWarning(w)}</li>
              ))}
            </ul>
          }
        />
      )}
    </>
  );
}
