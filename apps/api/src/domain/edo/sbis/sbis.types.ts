/**
 * Ответы API СБИС — терпимые схемы.
 *
 * Схемы проверяют только то, на что опирается код, и пропускают остальное
 * (`passthrough`): проба для того и нужна, чтобы увидеть ответ целиком. Числа и
 * флаги СБИС отдаёт строками («Да»/«Нет», «50»), но на случай чисел значения
 * приводятся к строке.
 *
 * Справка: СБИС.СписокНашихОрганизаций (all_methods/company), СБИС.СписокИзменений
 * (all_methods/changeslist), СБИС.ПрочитатьДокумент (all_methods/read_doc),
 * объект «Навигация» (all_methods/navigation).
 */
import { z } from 'zod';

const str = z.preprocess(
  (v) => (v == null ? undefined : typeof v === 'number' || typeof v === 'boolean' ? String(v) : v),
  z.string().optional(),
);

const list = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (v == null ? [] : Array.isArray(v) ? v : [v]), z.array(item));

export const SbisNavigationSchema = z
  .object({ ЕстьЕще: str, Страница: str, РазмерСтраницы: str })
  .passthrough();

const LegalSchema = z
  .object({ ИНН: str, КПП: str, КодФилиала: str, Название: str })
  .passthrough();
const PersonSchema = z
  .object({ ИНН: str, Фамилия: str, Имя: str, Отчество: str, КодФилиала: str })
  .passthrough();

export const SbisOrgSchema = z
  .object({
    СвЮЛ: LegalSchema.optional(),
    СвФЛ: PersonSchema.optional(),
    ДокументооборотПодключен: str,
  })
  .passthrough();
export type SbisOrg = z.infer<typeof SbisOrgSchema>;

export const SbisOrgListSchema = z
  .object({ НашаОрганизация: list(SbisOrgSchema), Навигация: SbisNavigationSchema.optional() })
  .passthrough();

const FileSchema = z.object({ Имя: str, Ссылка: str }).passthrough();

export const SbisAttachmentSchema = z
  .object({
    Идентификатор: str,
    Тип: str,
    Подтип: str,
    Название: str,
    Направление: str,
    Служебный: str,
    ВерсияФормата: str,
    Номер: str,
    Дата: str,
    /** Справка: у вложения — объект с `ДатаВремя` и `Номер`. */
    Редакция: z.unknown().optional(),
    Файл: FileSchema.optional(),
    Подпись: z.unknown().optional(),
  })
  .passthrough();
export type SbisAttachment = z.infer<typeof SbisAttachmentSchema>;

export const SbisEventSchema = z
  .object({
    Идентификатор: str,
    Название: str,
    ДатаВремя: str,
    Вложение: list(SbisAttachmentSchema),
  })
  .passthrough();
export type SbisEvent = z.infer<typeof SbisEventSchema>;

const PartySchema = z
  .object({ СвЮЛ: LegalSchema.optional(), СвФЛ: PersonSchema.optional() })
  .passthrough();

const RevisionSchema = z.object({ Идентификатор: str, ДатаВремя: str }).passthrough();

export const SbisDocumentSchema = z
  .object({
    Идентификатор: str,
    Тип: str,
    Подтип: str,
    Номер: str,
    Дата: str,
    Направление: str,
    Удален: str,
    Контрагент: PartySchema.optional(),
    НашаОрганизация: PartySchema.optional(),
    /** Справка: массив из одной записи с `Идентификатор` редакции. */
    Редакция: list(RevisionSchema),
    Событие: list(SbisEventSchema),
    /** У `ПрочитатьДокумент` вложения лежат прямо в документе. */
    Вложение: list(SbisAttachmentSchema),
    /**
     * «Да» — СБИС урезал ответ (слишком много вложений, событий, подписей).
     * Справка: недостающее — через `СписокИзменений` с фильтром по документу и
     * дополнительным полем «СписокПоДокументу».
     */
    ЧастичныеДанные: str,
  })
  .passthrough();
export type SbisDocument = z.infer<typeof SbisDocumentSchema>;

export const SbisChangesSchema = z
  .object({ Документ: list(SbisDocumentSchema), Навигация: SbisNavigationSchema.optional() })
  .passthrough();

/** Реквизиты стороны: ИНН и название из `СвЮЛ` или `СвФЛ`. */
export function partyOf(party: z.infer<typeof PartySchema> | undefined): {
  inn: string | null;
  kpp: string | null;
  name: string | null;
} {
  if (party?.СвЮЛ) {
    return {
      inn: party.СвЮЛ.ИНН?.trim() || null,
      kpp: party.СвЮЛ.КПП?.trim() || null,
      name: party.СвЮЛ.Название?.trim() || null,
    };
  }
  if (party?.СвФЛ) {
    const fio = [party.СвФЛ.Фамилия, party.СвФЛ.Имя, party.СвФЛ.Отчество].filter(Boolean).join(' ');
    return { inn: party.СвФЛ.ИНН?.trim() || null, kpp: null, name: fio || null };
  }
  return { inn: null, kpp: null, name: null };
}

/** «Да» — истина; всё остальное, включая отсутствие, — нет. */
export function isYes(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'да';
}

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Дата и время СБИС «ДД.ММ.ГГГГ ЧЧ.ММ.СС[.дробь]» по Москве → момент времени.
 * Только дата «ДД.ММ.ГГГГ» — начало дня по Москве. Не разобралось — null.
 */
export function parseSbisDateTime(value: string | undefined | null): Date | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2})[.:](\d{2})[.:](\d{2})(?:[.,](\d{1,6}))?)?$/.exec(
    value?.trim() ?? '',
  );
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0', frac = '0'] = m;
  const ms = Math.round(Number(`0.${frac}`) * 1000);
  const utc =
    Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss), ms) -
    MSK_OFFSET_MS;
  const date = new Date(utc);
  // 31.02 и подобное Date.UTC «переносит» на март — такую дату не принимаем.
  const check = new Date(utc + MSK_OFFSET_MS);
  if (check.getUTCDate() !== Number(dd) || check.getUTCMonth() !== Number(mm) - 1) return null;
  return date;
}

/** Момент времени → «ДД.ММ.ГГГГ ЧЧ.ММ.СС» по Москве (формат фильтров СБИС). */
export function formatSbisDateTime(date: Date): string {
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);
  return (
    `${pad(msk.getUTCDate())}.${pad(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()} ` +
    `${pad(msk.getUTCHours())}.${pad(msk.getUTCMinutes())}.${pad(msk.getUTCSeconds())}`
  );
}

/** «ДД.ММ.ГГГГ» (или с временем) → «ГГГГ-ММ-ДД» по Москве. */
export function sbisDateToIso(value: string | undefined | null): string | null {
  const date = parseSbisDateTime(value);
  if (!date) return null;
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);
  return `${msk.getUTCFullYear()}-${pad(msk.getUTCMonth() + 1)}-${pad(msk.getUTCDate())}`;
}
