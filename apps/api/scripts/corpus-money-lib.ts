/**
 * Чистая часть черновой денежной разметки: разбор текстового слоя УПД.
 *
 * Вынесена из corpus-money-draft.ts по той же причине, что и prompt-ab-lib:
 * инструмент, который готовит ЭТАЛОН, обязан быть проверяемым. За первый час
 * работы этот разбор трижды ошибся молча — терял строку-услугу с прочерками,
 * округлял копейки в бланках с точкой вместо запятой и удваивал позиции на
 * втором экземпляре документа. Каждая ошибка выглядела как аккуратный
 * результат, и ловила их только сверка суммы позиций с итогом.
 *
 * Здесь нет ни файловой системы, ни запуска pdftotext — только текст на входе.
 */
/** Графы бланка, которые нас интересуют. */
const COL = { rowNo: '1', qty: '3', price: '4', base: '5', vatSum: '8', sum: '9' } as const;

export type DraftItem = {
  rowNo: number;
  qty: number | null;
  price: number | null;
  sum: number | null;
  vatSum: number | null;
};

export type DraftDocument = {
  docNumber: string | null;
  totalSum: number | null;
  vatSum: number | null;
  items: DraftItem[];
  /** Строки таблицы, которые не разобрались однозначно. Заполнять руками. */
  unparsed: string[];
  /**
   * Расхождение суммы позиций с итогом документа.
   *
   * Единственная проверка, которая ловит ПОТЕРЯННУЮ строку: черновик,
   * пропустивший позицию, выглядит полным — просто в нём на одну строку
   * меньше. Первый же прогон так и потерял «Доставку» с прочерками в графах
   * количества и цены. Непустое поле означает «черновику доверять нельзя,
   * пока человек не разберётся».
   */
  totalsMismatch?: string;
  /**
   * Почему документ НЕ покрыт денежной сверкой.
   *
   * Пишется явно, а не оставляется умолчанием: документ без итога выглядит в
   * черновике так же аккуратно, как проверенный, и при переносе в манифест его
   * легко принять за размеченный. Непокрытый документ в эталон не переносится
   * вовсе — сверять его позиции не с чем.
   */
  notCovered?: string;
};

export type DraftEntry = {
  filename: string;
  parsePath: string;
  documents: DraftDocument[];
  /** Почему файл не покрыт (нет шапки таблицы, нет текстового слоя и т.п.). */
  skipped?: string;
};
/**
 * Первое число из ячейки бланка: «40 880,00 --» → 40880, «1 Грунт…» → 1.
 *
 * Именно первое, а не «вся ячейка целиком»: срез по координатам колонки
 * захватывает и соседний текст (продолжение наименования, прочерки графы 10),
 * а число в колонке всегда стоит левее этого хвоста. Разделитель тысяч —
 * пробел или неразрывный; дробная часть — запятая ИЛИ точка: бланки печатают
 * и «65 104,55», и «65 104.55». Без второго варианта копейки молча терялись —
 * поймала сверка итога с суммой позиций на УПД № ЦБ-641.
 */
export function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/\u00a0/g, ' ');
  const match = /(\d[\d ]*(?:[.,]\d+)?)/.exec(cleaned);
  if (!match?.[1]) return null;
  const normalized = match[1].replace(/ /g, '').replace(',', '.');
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Координаты колонок из служебной строки бланка.
 *
 * Возвращает для каждой нужной графы диапазон символов: от начала её метки до
 * начала следующей. Числа в бланке выровнены по правому краю, поэтому границей
 * служит именно следующая метка, а не ширина текущей.
 */
export function columnRanges(headerLine: string): Map<string, [number, number]> | null {
  const tokens: { label: string; start: number }[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(headerLine)) !== null) {
    tokens.push({ label: match[0], start: match.index });
  }
  // Шапка бланка начинается с «А 1 1а 1б 2 2а 3 4 5». Без этой цепочки строка
  // не служебная, а обычный текст — например, наименование с цифрами.
  const labels = tokens.map((t) => t.label);
  // Первая метка — графа «А» (код товара). В части бланков она набрана
  // латинской «A»: глазами не отличить, для сравнения — разные символы.
  const anchor = ['1', '1а', '1б', '2', '2а', '3', '4', '5'];
  const at = labels.findIndex(
    (label, i) => /^[АA]$/u.test(label) && anchor.every((a, k) => labels[i + 1 + k] === a),
  );
  if (at < 0) return null;

  const ranges = new Map<string, [number, number]>();
  for (let i = at; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    // Правая граница — начало следующей метки; у последней колонки — конец строки.
    ranges.set(token.label, [token.start, next ? next.start : headerLine.length + 40]);
  }
  return ranges;
}

/** Значение графы: срез строки по координатам колонки. */
export function cell(line: string, range: [number, number] | undefined): string {
  if (!range) return '';
  const [from, to] = range;
  // Числа выровнены вправо и часто заходят левее метки графы на пару символов.
  const start = Math.max(0, from - 6);
  return line.slice(start, Math.min(line.length, to));
}

export function extract(text: string): DraftDocument[] {
  const docs: DraftDocument[] = [];
  /** Документ по номеру — чтобы отличить второй экземпляр от продолжения. */
  const byNumber = new Map<string, DraftDocument>();
  let current: DraftDocument | null = null;
  let ranges: Map<string, [number, number]> | null = null;

  const lines = text.split('\n');
  for (const line of lines) {
    // Новый логический документ: «Счет-фактура № 258 от 2 июля 2026 г.».
    // Регистр разный: часть бланков печатает «СЧЕТ-ФАКТУРА» заглавными, и без
    // флага `i` такие файлы не разбирались вовсе — ни одной позиции.
    const invoice = /сч[её]т-фактура\s*№\s*(\S+)/i.exec(line);
    if (invoice && invoice[1] && !/^\(?1\)?$/.test(invoice[1])) {
      const num = invoice[1];
      const known = byNumber.get(num);
      if (!known) {
        current = { docNumber: num, totalSum: null, vatSum: null, items: [], unparsed: [] };
        byNumber.set(num, current);
        docs.push(current);
      } else if (known.totalSum != null) {
        // Тот же номер, а документ уже дошёл до «Всего к оплате» — значит это
        // ВТОРОЙ ЭКЗЕМПЛЯР той же бумаги (в пачке их печатают по два). Его
        // позиции — те же самые: дописав их, мы удвоили бы суммы. Так и вышло
        // в первом прогоне: 11 968 против итога 5 984.
        current = null;
      } else {
        // Тот же номер, документ ещё не закрыт — это продолжение на следующей
        // странице, дописываем в него.
        current = known;
      }
      ranges = null;
      continue;
    }

    const header = columnRanges(line);
    if (header) {
      ranges = header;
      continue;
    }

    if (!current || !ranges) continue;

    // Итоги: «Всего к оплате (9)» — суммы стоят в тех же графах 5, 8, 9.
    if (/Всего к оплате/.test(line)) {
      current.vatSum = parseNumber(cell(line, ranges.get(COL.vatSum)));
      current.totalSum = parseNumber(cell(line, ranges.get(COL.sum)));
      // Таблица кончилась. Дальше идут подписи и шапка следующей страницы, где
      // в координатах графы 1 стоит ИНН продавца — без сброса он попадал в
      // позиции номером 7716794678.
      ranges = null;
      continue;
    }

    const rowNo = parseNumber(cell(line, ranges.get(COL.rowNo)));
    // Верхняя граница — от реквизитов, попадающих в ту же колонку на других
    // страницах: номер позиции в бланке трёхзначный в самом худшем случае,
    // а ИНН и коды товара — на порядки больше.
    if (rowNo == null || !Number.isInteger(rowNo) || rowNo <= 0 || rowNo > 999) continue;

    const item: DraftItem = {
      rowNo,
      qty: parseNumber(cell(line, ranges.get(COL.qty))),
      price: parseNumber(cell(line, ranges.get(COL.price))),
      sum: parseNumber(cell(line, ranges.get(COL.sum))),
      vatSum: parseNumber(cell(line, ranges.get(COL.vatSum))),
    };
    // Строка таблицы — та, где есть номер позиции и хотя бы одно число.
    //
    // Требовать количество нельзя: строки-услуги («Доставка») печатают с
    // прочерками в графах 3 и 4, а стоимость в графе 9 у них есть. Такая
    // строка не мусор, а самый ценный для эталона случай: он утверждает, что
    // цена в бланке ОТСУТСТВУЕТ, и ловит модель, которая её выдумывает.
    // Продолжения многострочного наименования чисел не содержат вовсе и
    // отсеиваются этим же условием.
    if (item.qty == null && item.price == null && item.sum == null && item.vatSum == null) {
      continue;
    }
    current.items.push(item);
  }

  for (const doc of docs) {
    // Итог документа сверяется с суммой позиций: расхождение почти всегда
    // значит, что строка не попала в черновик (или попала дважды).
    if (doc.totalSum == null) {
      // «Всего к оплате» в бланке не нашлось — проверить полноту позиций
      // нечем. Такой документ помечается непокрытым и ждёт ручной разметки.
      doc.notCovered = 'итог «Всего к оплате» не найден — сверять полноту позиций не с чем';
      continue;
    }
    if (doc.items.length === 0) continue;
    if (doc.items.some((i) => i.sum == null)) continue;
    const sum = doc.items.reduce((acc, i) => acc + (i.sum ?? 0), 0);
    const diff = Math.round((sum - doc.totalSum) * 100) / 100;
    if (Math.abs(diff) > 0.01) {
      doc.totalsMismatch = `сумма позиций ${sum.toFixed(2)} против итога ${doc.totalSum.toFixed(2)} (разница ${diff.toFixed(2)})`;
    }
  }

  return docs;
}
