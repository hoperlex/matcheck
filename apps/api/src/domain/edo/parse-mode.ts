/**
 * Режим разбора документа и режимы, где разрешена машинная правка количества.
 *
 * Жили в worker.ts. Вынесены сюда, потому что worker исполняемый: импорт из
 * него запускает процесс, и офлайн-сверки (scripts/upd-prompt-ab.ts) не могли
 * воспроизвести условие, при котором воркер действительно сохраняет правку.
 * Сверка, применяющая правило безусловно, показывала результат лучше боевого.
 */

/**
 * Чем разобран документ. Нужен, чтобы решать про второй проход: булев
 * `parsedViaVision` для этого не годится — у структурного Excel он тоже false,
 * и слабый .xlsx ушёл бы в vision как PDF.
 */
export type ParseMode =
  | 'text'
  | 'text_bundle'
  | 'vision_pdf'
  | 'vision_bundle'
  | 'image_vision'
  | 'excel_structural'
  | 'excel_vision'
  | 'm15_vision'
  | 'second_pass_vision'
  // Логический УПД, собранный из страниц пакета (см. bundle_segments).
  | 'segment_vision'
  // Накладная (ТН/ОС-2), разобранная пакетным parseWaybillBatch. Ставится не
  // в handleJob, а в createSourceDocumentFromWaybill: у пакетного пути свой обработчик.
  | 'waybill_batch';

/**
 * Режимы разбора, где разрешено восстановление количества.
 *
 * Только vision-пути: дефект «количество съехало на соседнюю графу» — свойство
 * чтения картинки. У текстового PDF и у Excel числа берутся из самого файла,
 * и подменять их арифметикой не за чем.
 */
export const QTY_REPAIR_PARSE_MODES: ReadonlySet<ParseMode> = new Set<ParseMode>([
  'vision_pdf',
  'vision_bundle',
  'image_vision',
  'm15_vision',
  'segment_vision',
]);
