/**
 * Машиночитаемый ли документ и как его тип называется по-русски.
 *
 * Прежде «машиночитаемым» в осмотре считался только тот документ, который шёл
 * в разбор УПД, — поэтому счёт-фактура в XML показывалась как «скан или PDF».
 * Теперь ответ даёт справочник типов Диадока (`GetDocumentTypes`), а если он
 * недоступен — версия формата: у формализованных документов она кончается
 * номером версии XML-схемы (`utd970_05_03_01`), у файлов без схемы — нет.
 */
import type { DiadocDocumentTypeInfo } from './diadoc.client.js';

/** Версия формата ФНС в конце имени версии: `_05_03_01`. */
const FORMAT_VERSION = /_\d{2}_\d{2}_\d{2}$/;

export type Formality = {
  formalized: boolean;
  source: 'reference' | 'version';
  title: string | null;
};

export type FormalityLookup = (
  typeNamedId: string,
  fn: string | null,
  version: string | null,
) => Formality;

export function buildFormalityLookup(types: DiadocDocumentTypeInfo[] | null): FormalityLookup {
  const byType = new Map((types ?? []).map((t) => [t.name, t]));

  return (typeNamedId, fn, version) => {
    const type = byType.get(typeNamedId);
    const title = type?.title ?? null;
    const exact = type?.versions.find(
      (v) => v.version === version && (fn === null || v.fn === null || v.fn === fn),
    );
    if (exact && exact.isFormal !== null) {
      return { formalized: exact.isFormal, source: 'reference', title };
    }
    const formalized =
      typeNamedId !== 'Nonformalized' && version !== null && FORMAT_VERSION.test(version);
    return { formalized, source: 'version', title };
  };
}
