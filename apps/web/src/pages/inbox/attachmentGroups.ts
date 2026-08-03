// Разделение вложений письма на то, что видно сразу, и то, что свёрнуто.
//
// Зачем. Подрядчики шлют письма с картинками из подписи: в 15 боевых письмах
// из 49 такие есть, а в одном их шестнадцать штук — при восьми вложениях семь
// оказываются иконками по килобайту. Показанные вперемешку, они выдавливают из
// карточки и текст письма, и сам документ.
//
// Логика вынесена из вёрстки намеренно: правило «если пригодных вложений нет —
// раскрыть группу сразу» ломается одной строкой, а тестами разметку не
// покрыть.

/** Минимум, который нужен от вложения для группировки. */
export type GroupableAttachment = {
  state: 'kept' | 'restored' | 'suspected_signature' | 'skipped';
  /** Пойдёт ли файл в пакет документов. */
  willBeIngested: boolean;
};

export type AttachmentGroups<T> = {
  /** Показываются сразу — ради них оператор и открыл письмо. */
  documents: T[];
  /** Свёрнуто: подписи и всё, что фильтр отклонил. */
  hidden: T[];
  /** Заголовок свёрнутой группы; `null`, когда прятать нечего. */
  hiddenLabel: string | null;
  /**
   * Раскрывать ли группу при открытии карточки. Раскрываем, только когда
   * показывать больше нечего: иначе оператор увидит пустой список и не поймёт,
   * что именно возвращать кнопкой «Вернуть».
   */
  hiddenOpenByDefault: boolean;
};

export function splitAttachments<T extends GroupableAttachment>(
  attachments: readonly T[],
): AttachmentGroups<T> {
  const documents = attachments.filter((a) => a.willBeIngested);
  const hidden = attachments.filter((a) => !a.willBeIngested);

  // Заголовок по составу: «подписи» — понятная оператору формулировка, но она
  // была бы враньём, если рядом лежит отброшенный по типу файл.
  const onlySignatures = hidden.length > 0 && hidden.every((a) => a.state === 'suspected_signature');

  return {
    documents,
    hidden,
    hiddenLabel:
      hidden.length === 0
        ? null
        : onlySignatures
          ? `Похоже на подписи (${hidden.length})`
          : `Не пойдут в пакет (${hidden.length})`,
    hiddenOpenByDefault: documents.length === 0 && hidden.length > 0,
  };
}

/**
 * Какое вложение показать в предпросмотре при открытии карточки.
 *
 * Сначала документ, а если их нет — первое вложение вообще: пустая область
 * предпросмотра ничего не сообщает оператору, а иконка подписи хотя бы
 * объясняет, что за файл пришёл.
 */
export function pickActiveAttachment<T extends GroupableAttachment & { id: string }>(
  attachments: readonly T[],
): string | null {
  return (attachments.find((a) => a.willBeIngested) ?? attachments[0])?.id ?? null;
}
