/**
 * Проверки распознанных сторон документа перед записью: что можно заводить в
 * справочник контрагентов и какие реквизиты вообще считать принадлежащими
 * стороне.
 *
 * Зачем. Стороны приходят от vision-модели, и она ошибается двумя разными
 * способами, у каждого своя защита.
 *
 * 1. Неверный ИНН. На боевых данных одна организация «СУ-10» лежит в
 *    справочнике в одиннадцати вариантах — перестановки цифр (7736255608,
 *    7736255088), чужой ИНН, шестизначный мусор «127018» (индекс из адреса).
 *    Каждая такая запись создана автоматически и остаётся навсегда: удалять
 *    нельзя, на неё уже ссылаются документы. Отсюда `normalizePartyForDirectory`
 *    — он решает, заводить ли новую запись справочника, и на сами распознанные
 *    значения не влияет: `*_name_raw` и `*_inn_raw` пишутся как пришли.
 *
 * 2. Чужой ИНН, скопированный из соседней графы. Промпт v9 включили на бою
 *    14.08, и модель начала подставлять ИНН и КПП покупателя грузополучателю:
 *    документ 1736 получил «ООО "АЛЬЯНС"» с реквизитами СУ-10 (1 случай из 3).
 *    Первая защита здесь бессильна — ИНН настоящий и валидный, просто чужой.
 *    Отсюда `consigneeOwnIdentity`, и он, в отличие от первой, ВЛИЯЕТ на
 *    сохраняемые значения: заведомо скопированный ИНН в `consignee_inn_raw` не
 *    попадает, потому что «сырое» значение там имеет смысл только пока оно
 *    отвечает на вопрос «что стояло в документе».
 */
import { normalizeInn } from './resolve-contractor.js';
import { normalizeOrgName } from './org-name.js';

/**
 * Сторона как её вернул парсер. Поля необязательные: в `UpdPdfPartySchema` они
 * `.nullable().optional()`, и сужать тип здесь нельзя — сюда приходит
 * `parsed.consignee` как есть.
 */
export type RawParty = {
  inn?: string | null;
  kpp?: string | null;
  name?: string | null;
};

export type DirectoryParty = { inn: string; kpp: string | null; name: string };

/**
 * Обрывки подписей граф, которые модель и текстовые парсеры иногда отдают
 * вместо названия организации. В справочнике им не место.
 */
const LABEL_MARKERS = [
  /^он\s+же$/iu,
  /^и\s+его\s+адрес/iu,
  /^грузополучател/iu,
  /^грузоотправител/iu,
  /^покупател/iu,
  /^продавец/iu,
  /^\(\d+[а-я]?\)$/u,
  /^[-—–]+$/u,
];

/** Название, пригодное для записи в справочник, либо null. */
export function normalizePartyName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  // «ИП» — самое короткое осмысленное имя, что встречается; всё короче трёх
  // символов это обрывок распознавания, а не организация.
  if (name.length < 3) return null;
  if (LABEL_MARKERS.some((re) => re.test(name))) return null;
  return name;
}

/**
 * Приводит распознанную сторону к виду, пригодному для СОЗДАНИЯ записи
 * справочника, либо возвращает null — тогда контрагент не заводится.
 *
 * Требования: ИНН проходит нормализацию с контрольными цифрами (`normalizeInn`)
 * и имя не является обрывком подписи. КПП берём только девятизначный — иначе
 * null: пустой КПП лучше мусорного, он участвует в ключе поиска.
 */
export function normalizePartyForDirectory(party: RawParty): DirectoryParty | null {
  const inn = normalizeInn(party.inn);
  if (!inn) return null;
  const name = normalizePartyName(party.name);
  if (!name) return null;
  const kppDigits = (party.kpp ?? '').replace(/\D/g, '');
  return { inn, kpp: kppDigits.length === 9 ? kppDigits : null, name };
}

/** Только цифры — для сравнения ИНН, записанных с пробелами или дефисами. */
function innDigits(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '');
}

/**
 * Реквизиты грузополучателя — свои или скопированные у покупателя.
 *
 * Графа 4 формы 1137 ИНН и КПП не содержит: там печатают только наименование и
 * адрес. Тем не менее модель по промпту v9 повторяет реквизиты покупателя даже
 * тогда, когда название грузополучателя ДРУГОЕ, — так документ 1736 получил
 * «ООО "АЛЬЯНС"» с ИНН и КПП компании «СУ-10». Итог для пользователя: в колонке
 * второй строкой стоит чужой ИНН, а ссылка на справочник ведёт на другое
 * юрлицо.
 *
 * Отличить подстановку от законного случая можно по названию: «он же» в графе 4
 * означает «грузополучатель тот же, что покупатель», и тогда совпадают И ИНН,
 * И наименование. Разные названия при одинаковом ИНН — это всегда ошибка
 * распознавания.
 *
 * Возвращаются ИСХОДНЫЕ значения, а не нормализованные: нормализация нужна
 * только для сравнения, а в `*_inn_raw` должно лежать то, что стояло в
 * документе.
 */
export function consigneeOwnIdentity(
  consignee: RawParty | null | undefined,
  recipient: RawParty | null | undefined,
): { inn: string | null; kpp: string | null } {
  const consigneeInn = consignee?.inn ?? null;
  const consigneeKpp = consignee?.kpp ?? null;
  const asIs = { inn: consigneeInn, kpp: consigneeKpp };

  // Нет ИНН — нечего и подозревать: это штатное состояние графы 4.
  if (!innDigits(consigneeInn)) return asIs;
  // Разные ИНН — сторона своя, вопросов нет.
  if (innDigits(consigneeInn) !== innDigits(recipient?.inn)) return asIs;

  const consigneeName = normalizeOrgName(consignee?.name);
  const recipientName = normalizeOrgName(recipient?.name);
  // Совпал ИНН и совпало название — законное «он же».
  if (consigneeName && recipientName && consigneeName === recipientName) return asIs;

  // Сюда попадают два случая: названия разные (явная подстановка) и одно из
  // названий пусто. Пустое имя доказательством «он же» служить не может —
  // сравнивать не с чем, поэтому реквизиты тоже отбрасываем.
  return { inn: null, kpp: null };
}

/**
 * Реквизиты грузополучателя повторяют покупателя, и сырая графа 4 этого не
 * подтверждает.
 *
 * Зачем отдельно от `consigneeOwnIdentity`. Тот ловит случай «имя своё, ИНН
 * чужой» — сравнением двух сторон между собой. Но когда модель копирует
 * покупателя ЦЕЛИКОМ (и имя, и ИНН), сравнение сторон бессильно: результат
 * неотличим от законного «он же». На бою так прошёл УПД № 9792 — в бланке
 * ООО «СУ-90» с собственным адресом, в ответе СУ-10 с реквизитами покупателя,
 * confidence 1,0, промпт v13 (где копировать прямо запрещено).
 *
 * Отличить можно только по тому, что напечатано в самой графе. Три случая:
 *   * буквальное «он же» — законно, реквизиты покупателя там и подразумеваются;
 *   * напечатанное наименование, совпадающее с покупателем, — тоже законно;
 *   * реквизиты совпали, а в графе ни того, ни другого — подозрение.
 *
 * Сырой текст приходит от той же модели и доказательством не является: она
 * способна выдумать и его. Поэтому результат — только предупреждение оператору,
 * никакой автоматической правки данных.
 *
 * `raw == null` (промпты до v14, текстовый путь) — молчим: проверять нечем, а
 * ложные предупреждения обесценят очередь ручной проверки.
 */
export function consigneeCopyUnverified(args: {
  consignee: RawParty | null | undefined;
  recipient: RawParty | null | undefined;
  raw: string | null | undefined;
}): boolean {
  const { consignee, recipient, raw } = args;
  if (raw == null || raw.trim() === '') return false;

  const consigneeInn = innDigits(consignee?.inn);
  const recipientInn = innDigits(recipient?.inn);
  const consigneeName = normalizeOrgName(consignee?.name);
  const recipientName = normalizeOrgName(recipient?.name);

  const sameInn = consigneeInn !== '' && consigneeInn === recipientInn;
  const sameName = consigneeName !== '' && consigneeName === recipientName;
  if (!sameInn && !sameName) return false;

  const normalizedRaw = normalizeOrgName(raw);
  // «он же» в графе 4 — прямое указание на покупателя. Пишут по-разному
  // («он же», «Он же.», «тот же»), поэтому ищем вхождением, а не равенством.
  //
  // Без \b: в JS граница слова определяется по латинице, и на кириллице
  // условие не срабатывает вовсе. Пробелы к этому моменту уже схлопнуты
  // normalizeOrgName, а внутри названия организации «он же» не встречается.
  if (normalizedRaw.includes('он же') || normalizedRaw.includes('тот же')) return false;
  // Наименование покупателя напечатано в графе целиком — тоже законно.
  if (recipientName !== '' && normalizedRaw.includes(recipientName)) return false;
  // Совпадение по короткому ядру названия: в графе печатают с адресом и
  // организационной формой, а в recipient.name может лежать краткая форма.
  const core = recipientName.replace(/^(ооо|оао|зао|ао|пао|ип)\s+/u, '').trim();
  if (core.length >= 4 && normalizedRaw.includes(core)) return false;

  return true;
}
