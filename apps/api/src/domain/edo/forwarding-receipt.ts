/**
 * Экспедиторская расписка транспортной компании («Деловые Линии» и др.).
 *
 * Зачем. Материалов в расписке нет — только «Сборный груз», число мест, вес,
 * стороны перевозки и услуги экспедитора. Но машина по ней всё равно приезжает
 * на объект, и инспектору нужна заявка: от кого груз, сколько мест. Поэтому
 * расписка становится «Накладной» (kind transport_waybill) с одной позицией
 * «груз — N мест», а реальные материалы МОЛ вносит на втором этапе приёмки.
 *
 * Раньше расписка уходила в общий разбор как неясный текст: классификатор
 * страниц отбрасывал лицевую сторону как транспортную накладную, УПД-промпт
 * читал оборот с условиями оферты и заводил «УПД, распознано частично» с
 * поставщиком-экспедитором (26-02261022358 от 05.11.2026). Промпт накладных
 * тоже не поможет: он знает только ТН-2116 и ОС-2, остальное велено игнорировать.
 *
 * Разбор детерминированный, по текстовому слою PDF, без модели: бланк печатается
 * программой экспедитора, раскладка стабильна. Фото и сканы без текста сюда не
 * попадают — у них нет текстового слоя.
 *
 * Особенность раскладки: лист напечатан ДВУМЯ одинаковыми экземплярами рядом,
 * и текстовый слой перемежает их колонки. Поэтому всё читается «первым
 * совпадением после метки» и в окне до метки следующей стороны.
 */
import { PDFParse } from 'pdf-parse';
import type { WaybillDocument } from '@matcheck/contracts';

const TITLE_RE = /экспедиторск[а-яё]*\s+расписк[а-яё]*/i;
/**
 * Заголовок обязан открывать файл: в счёте, договоре или акте расписка бывает
 * лишь упомянута, и такое упоминание не делает документ распиской.
 */
const LEAD_CHARS = 300;

/** Первая страница — бланк экспедиторской расписки, а не упоминание о ней. */
export function isForwardingReceiptLeadPage(text: string): boolean {
  const normalized = flat(text);
  const title = normalized.search(TITLE_RE);
  return title >= 0 && title < LEAD_CHARS;
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Номер и дата расписки: «№ NN-…» и сразу за ним «от ДД.ММ.ГГГГ».
 *
 * Рядом в шапке напечатан номер ЭЭР («ЭЭР № 26-0000…») — у него «от» нет, и
 * именно по этому признаку он не подхватывается. Номер второго экземпляра
 * может стоять между номером и датой — его пропускаем. Ищем только в шапке:
 * ниже есть «№GL-… от 28.04.2026» — договор экспедитора, а не расписка.
 */
const NUMBER_DATE_RE =
  /№\s*([0-9A-Za-zА-ЯЁа-яё][0-9A-Za-zА-ЯЁа-яё./-]{2,})(?:\s+№\s*[0-9A-Za-zА-ЯЁа-яё][0-9A-Za-zА-ЯЁа-яё./-]{2,})?\s+от\s+(\d{2})\.(\d{2})\.(\d{4})/;
const HEADER_CHARS = 500;

/**
 * Организация: правовая форма и название в кавычках. Кавычки бывают вложенные —
 * `ЗАО "ПО "СПЕЦАВТОМАТИКА"`: внутренняя кавычка стоит перед буквой,
 * закрывающая — перед пробелом или концом текста. ИП печатается без кавычек.
 * Граница слева обязательна: иначе «АО» нашлось бы внутри любого слова.
 */
const ORG_RE =
  /(?<![А-ЯЁа-яёA-Za-z])(?:(?:ООО|ЗАО|ОАО|ПАО|НАО|АО)\s+(?:"(?:[^"]|"(?=[^\s"]))*"|«(?:[^«»]|«[^«»]*»)*»)|ИП\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]*\.?){0,2})/;
const INN_RE = /ИНН(?:\s*\/\s*КПП)?\s*:?\s*(\d{12}|\d{10})(?!\d)/;
/** Как далеко после метки может стоять название организации. */
const ORG_WINDOW = 120;

type PartyLabel = 'Отправитель' | 'Получатель' | 'Плательщик' | 'Экспедитор';
const PARTY_LABELS: PartyLabel[] = ['Отправитель', 'Получатель', 'Плательщик', 'Экспедитор'];

/**
 * Сторона по метке: название сразу за меткой, ИНН — первый после метки, но не
 * дальше метки ДРУГОЙ стороны. Иначе у отправителя без ИНН подхватился бы ИНН
 * получателя.
 */
function readParty(
  text: string,
  label: PartyLabel,
): { name: string | null; inn: string | null } | null {
  const at = text.indexOf(label);
  if (at < 0) return null;
  const from = at + label.length;
  const ends = PARTY_LABELS.filter((l) => l !== label)
    .map((l) => text.indexOf(l, from))
    .filter((i) => i >= 0);
  const to = ends.length > 0 ? Math.min(...ends) : text.length;
  const window = text.slice(from, to);

  const org = ORG_RE.exec(window.slice(0, ORG_WINDOW));
  const inn = INN_RE.exec(window);
  return { name: org ? org[0].trim() : null, inn: inn ? inn[1]! : null };
}

/**
 * «всего N кг м³» — строка итогов груза. Число мест читается всегда; вес и
 * объём — только в однозначной записи (вес без разрядных пробелов, объём с
 * дробной частью). «всего 6 1 534 2,18» иначе прочиталось бы как 1 кг.
 */
const CARGO_TOTAL_RE = /всего\s+(\d+)(?=\s|$)/;
const CARGO_FULL_RE = /всего\s+(\d+)\s+(\d+)\s+(\d+[.,]\d+)(?=\s|$)/;

/**
 * Название груза — в строке, следующей за меткой «Наименование груза»: рядом
 * через колонку печатается «Экспедитор …», его отрезаем.
 */
function readCargoName(rawPage: string): string | null {
  const lines = rawPage.split(/\r?\n/).map((l) => l.trim());
  const idx = lines.findIndex((l) => /наименование\s+груза/i.test(l));
  if (idx < 0) return null;
  const next = lines.slice(idx + 1).find((l) => l.length > 0);
  if (!next) return null;
  const name = next.split(/\s+Экспедитор(?:\s|$)/)[0]!.trim();
  if (!name || /^экспедитор/i.test(name)) return null;
  return name.slice(0, 120);
}

const FALLBACK_CARGO_NAME = 'Груз по экспедиторской расписке';

/**
 * Разбор расписки по тексту страниц. null — это не расписка или прочитано
 * слишком мало, чтобы заводить документ: тогда файл идёт прежним путём.
 *
 * Порог: номер и хотя бы одно из «ИНН отправителя», «число мест». Без номера
 * документ не найти и не сверить; без отправителя и мест инспектору нечего
 * ждать на КПП.
 */
export function parseForwardingReceiptPages(pages: string[]): WaybillDocument | null {
  const rawFirst = pages[0] ?? '';
  if (!isForwardingReceiptLeadPage(rawFirst)) return null;
  const text = flat(rawFirst);

  const nd = NUMBER_DATE_RE.exec(text.slice(0, HEADER_CHARS));
  const docNumber = nd ? nd[1]! : null;
  const docDate = nd ? `${nd[4]}-${nd[3]}-${nd[2]}` : null;

  const shipper = readParty(text, 'Отправитель');
  const consignee = readParty(text, 'Получатель');

  const full = CARGO_FULL_RE.exec(text);
  const total = full ?? CARGO_TOTAL_RE.exec(text);
  const places = total ? Number(total[1]) : null;
  const cargoName = readCargoName(rawFirst) ?? FALLBACK_CARGO_NAME;
  const details = full ? ` (${full[2]} кг, ${full[3]} м³)` : '';

  if (!docNumber || (!shipper?.inn && places == null)) return null;

  const filled = [docNumber, docDate, shipper?.inn, consignee?.inn, places].filter(
    (v) => v != null,
  ).length;

  return {
    form: 'forwarding_receipt',
    docNumber,
    docDate,
    shipper: shipper && (shipper.inn || shipper.name) ? shipper : null,
    consignee: consignee && (consignee.inn || consignee.name) ? consignee : null,
    items:
      places != null && places > 0
        ? [{ nameRaw: `${cargoName}${details}`, qty: places, unit: 'мест' }]
        : [],
    confidence: Math.round((filled / 5) * 100) / 100,
  };
}

/**
 * Пакет накладных целиком из расписок — в форме ответа парсера накладных.
 *
 * Только ОДНОРОДНЫЙ пакет, как у маршрута 1-Т: вложения пакета прикрепляются ко
 * всем созданным документам, и увести смешанную пачку к разбору расписок
 * значило бы потерять лежащие рядом ТН-2116 и ОС-2. null — пакет идёт прежним
 * путём (модель).
 */
export async function parseForwardingReceiptBatch(
  files: ReadonlyArray<{ buffer: Buffer; mimeType: string }>,
): Promise<{ parsed: { documents: WaybillDocument[] }; llmProviderId: null } | null> {
  if (files.length === 0) return null;
  const docs = await Promise.all(
    files.map((f) => detectAndParseForwardingReceipt(f.buffer, f.mimeType)),
  );
  if (!docs.every((d): d is WaybillDocument => d !== null)) return null;
  return { parsed: { documents: docs }, llmProviderId: null };
}

/**
 * Расписка ли это и что в ней. Читает текстовый слой PDF; для остальных типов,
 * сканов без текста и битых файлов возвращает null — маршрут файла не меняется.
 */
export async function detectAndParseForwardingReceipt(
  buffer: Buffer,
  mimeType: string,
): Promise<WaybillDocument | null> {
  if (!/pdf/i.test(mimeType)) return null;
  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const r = await parser.getText();
      const pages = (r.pages ?? []).map((p) => p.text ?? '');
      return parseForwardingReceiptPages(pages);
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  } catch {
    return null;
  }
}
