/**
 * Организация СБИС в `edo_accounts.box_id`.
 *
 * У Диадока в box_id лежит id ящика. У СБИС ящика нет — лента фильтруется по
 * организации (`НашаОрганизация`: ИНН, КПП, код филиала; у ИП — только ИНН), и
 * она же входит в идентичность курсора выгрузки. Хранится полная ссылка, а не
 * «ИНН/КПП»: без вида и филиала фильтр собрался бы не тот.
 *
 * Формат: `вид:ИНН:КПП:филиал`, пустые части — пусто
 * (`legal:7736255508:774550001:`). Функции туда и обратно — единственные.
 */
import type { SbisOrgRef } from './sbis.client.js';

export function formatOrgRef(ref: Pick<SbisOrgRef, 'kind' | 'inn' | 'kpp' | 'branch'>): string {
  return [ref.kind, ref.inn, ref.kpp ?? '', ref.branch ?? ''].join(':');
}

export function parseOrgRef(value: string | null | undefined): SbisOrgRef | null {
  const parts = (value ?? '').split(':');
  if (parts.length !== 4) return null;
  const [kind, inn, kpp, branch] = parts as [string, string, string, string];
  if (kind !== 'legal' && kind !== 'person') return null;
  if (kind === 'legal' && !/^\d{10}$/.test(inn)) return null;
  if (kind === 'person' && !/^\d{12}$/.test(inn)) return null;
  if (kpp && !/^\d{9}$/.test(kpp)) return null;
  if (kind === 'person' && kpp) return null;
  return { kind, inn, kpp: kpp || null, branch: branch || null, name: null };
}
