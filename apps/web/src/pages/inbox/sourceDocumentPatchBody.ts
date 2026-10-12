import { normalizeInn } from '../../shared/utils/inn';

/**
 * Тело PATCH карточки документа: только то, что человек действительно изменил.
 *
 * Раньше «Сохранить» отправляло всю шапку и все позиции, и сервер на любое
 * сохранение — хоть одного МОЛ — пересоздавал строки документа (у строк
 * приёмки ссылка на них ON DELETE SET NULL, точные связи рвались), поднимал
 * ревизию машины и пересчитывал статус, стирая «Принять как есть».
 *
 * Сравнение идёт по уже собранным телам — текущему и «как открыли» — одной и
 * той же функцией сборки. Поэтому нетронутое поле совпадает с собой
 * побайтно, а различия в представлении гасятся здесь: InputNumber на blur
 * без единой правки превращает '60263.00' в 60263, и это не изменение.
 */

/** Сторона документа (покупатель, грузополучатель) в форме карточки. */
export type DocumentPartyValue = {
  name: string;
  inn: string | null;
  /**
   * Откуда значение: распознано в документе, выбрано из справочника или
   * введено вручную. Определяет только UI — поле ИНН показывается у ручного
   * ввода. На сервер не уходит.
   */
  source: 'document' | 'directory' | 'manual';
};

export type DocumentPartyPayload = { name: string; inn: string | null };

export type PartySide = 'buyer' | 'consignee';

/** Сторона в теле PATCH. ИНН здесь ещё сырой — нормализует finalizePartyPayloads. */
export function partyPayload(value: DocumentPartyValue | null): DocumentPartyPayload | null {
  if (!value) return null;
  const inn = value.inn?.trim();
  return { name: value.name.trim(), inn: inn ? inn : null };
}

const NUMERIC_KEYS = new Set(['totalSum']);
const ITEM_NUMERIC_KEYS = new Set(['qty', 'price', 'sum', 'vatRate']);

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

function sameNumber(a: unknown, b: unknown): boolean {
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a) === String(b);
  return na === nb;
}

function sameScalar(a: unknown, b: unknown): boolean {
  // Пустая строка и null для поля формы — одно и то же «пусто»: очищенный
  // Input отдаёт '', а из базы пришёл null.
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  return a === b;
}

function sameItems(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((row, i) => {
    const other = b[i] as Record<string, unknown>;
    const current = row as Record<string, unknown>;
    const keys = new Set([...Object.keys(current), ...Object.keys(other)]);
    return [...keys].every((key) =>
      ITEM_NUMERIC_KEYS.has(key)
        ? sameNumber(current[key], other[key])
        : sameScalar(current[key], other[key]),
    );
  });
}

function innDigits(inn: string | null | undefined): string {
  return (inn ?? '').replace(/\D/g, '');
}

function sameParty(a: unknown, b: unknown): boolean {
  const pa = a as DocumentPartyPayload | null;
  const pb = b as DocumentPartyPayload | null;
  if (!pa || !pb) return !pa && !pb;
  return pa.name.trim() === pb.name.trim() && innDigits(pa.inn) === innDigits(pb.inn);
}

function samePatchValue(key: string, a: unknown, b: unknown): boolean {
  if (key === 'items') return sameItems(a, b);
  if (key === 'buyer' || key === 'consignee') return sameParty(a, b);
  if (NUMERIC_KEYS.has(key)) return sameNumber(a, b);
  return sameScalar(a, b);
}

/**
 * Ключи `current`, значение которых отличается от `pristine`.
 *
 * `items` при любом отличии уходят целиком: сервер заменяет строки документа
 * полностью, и половина списка означала бы потерю остальных позиций.
 */
export function diffPatchBody(
  current: Record<string, unknown>,
  pristine: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!(key in pristine) || !samePatchValue(key, value, pristine[key])) out[key] = value;
  }
  return out;
}

/**
 * Приводит ИНН изменённых сторон к цифрам — то, что примет сервер.
 *
 * Проверка нужна только изменённой стороне: нетронутая в тело не попадает, и
 * распознанный с ошибкой ИНН документа не должен запирать сохранение
 * остальных полей.
 *
 * Возвращает сторону с битым ИНН, если такая есть, — тогда тело не
 * отправляется.
 */
export function finalizePartyPayloads(body: Record<string, unknown>): PartySide | null {
  for (const side of ['consignee', 'buyer'] as const) {
    if (!(side in body)) continue;
    const party = body[side] as DocumentPartyPayload | null;
    if (!party || party.inn == null) continue;
    const inn = normalizeInn(party.inn);
    if (!inn) return side;
    body[side] = { ...party, inn };
  }
  return null;
}
