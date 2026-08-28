import type { UpdPdfParsed } from '@matcheck/contracts';

/**
 * Подтверждение дубликата СОДЕРЖИМЫМ, а не только реквизитами.
 *
 * Зачем. Дубликат ставится по совпадению «вид + поставщик + номер + дата», и
 * этого недостаточно: за месяц из 126 таких пар у 23 разошлись суммы, у 21 —
 * число позиций, а в 9 случаях спрятанный разбор оказался ТОЧНЕЕ оставшегося.
 * То есть примерно двадцать раз в месяц с планшета убирался документ, про
 * который нельзя утверждать, что он копия.
 *
 * Почему решают ЧИСЛА, а не наименования. Первая редакция сравнивала и текст
 * тоже — и на боевых данных подтвердила бы лишь 58 пар из 117: остальные 59
 * снова появились бы на планшете, задваивая материалы. Разбор показал, что у
 * 31 пары расходились ТОЛЬКО написания, потому что модель читает символы
 * нестабильно: `5x4` против `5х4` (латиница против кириллицы), `n-i60/40t`
 * против `n-l60/40т`, лишний ноль в `0,7x1250x20000`. Это один бланк,
 * прочитанный дважды. Поэтому наименование и единица в решение не входят —
 * они попадают в пояснение для человека, — а сравниваются величины, которые
 * модель воспроизводит устойчиво: итог, число позиций, количества и суммы.
 *
 * Риск ложного скрытия при этом остаётся ничтожным: чтобы совпали все
 * количества и суммы построчно, документы должны быть одним бланком — ключ
 * дедупликации уже требует одного поставщика, номера и даты.
 *
 * Отдельное правило: ОТСУТСТВУЮЩЕЕ значение не доказывает ничего. Если в одном
 * прогоне НДС синтезировался, а в другом нет, это не различие документов; но и
 * подтверждением совпадения пустота быть не может. Поэтому сравнение
 * трёхзначное на уровне каждого поля.
 *
 * Ветки `different` и `unknown` ведут себя одинаково — документ остаётся
 * видимым. Разделены они ради человека: «содержимое различается» и «сравнить
 * нечем» требуют разного объяснения в карточке.
 */
export type DuplicateVerdict =
  | { kind: 'confirmed'; by: 'file_hash' | 'fingerprint'; detail: string }
  | { kind: 'different'; detail: string }
  | { kind: 'unknown'; detail: string };

/** Результат сравнения одного поля. `unknown` — значения нет у одной из сторон. */
type FieldCmp = 'equal' | 'differs' | 'unknown';

/** Точность сравнения денег — та же, что у хранения (numeric(_, 2)). */
function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '∅';
  return (Math.round(v * 100) / 100).toFixed(2);
}

/** Количество хранится с четырьмя знаками. */
function qty(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '∅';
  return (Math.round(v * 10000) / 10000).toFixed(4);
}

function cmp(a: string, b: string): FieldCmp {
  if (a === '∅' || b === '∅') return 'unknown';
  return a === b ? 'equal' : 'differs';
}

/**
 * Наименование сравнивается только ради пояснения: регистр, лишние пробелы и
 * переносы строк у одного товара пляшут от прогона к прогону.
 */
function name(v: string | null | undefined): string {
  return (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Числовой отпечаток документа — то, по чему принимается решение.
 *
 * Позиции НЕ сортируются: перестановка строк — это другой документ ровно в той
 * же мере, что и другое количество. Сортировка сгладила бы реальное различие.
 */
export function documentFingerprint(p: UpdPdfParsed): string {
  const header = [money(p.totalSum), String(p.items.length)].join('|');
  const rows = p.items.map((i) => [qty(i.qty), money(i.sum)].join('|'));
  return [header, ...rows].join('\n');
}

/** Текстовый слепок — в решение не входит, служит формулировкой причины. */
function textFingerprint(p: UpdPdfParsed): string {
  return p.items.map((i) => `${name(i.nameRaw)}|${name(i.unit)}`).join('\n');
}

/**
 * Совпадают ли два разбора настолько, что второй можно скрыть.
 *
 * @param fileHashesMatch совпадает ли хеш исходного файла. Это самое сильное
 *   доказательство: один и тот же байтовый файл загружен дважды. Проверяется
 *   ДО содержимого, потому что не зависит от качества распознавания.
 */
export function verdictForDuplicate(
  candidate: UpdPdfParsed,
  existing: UpdPdfParsed,
  fileHashesMatch: boolean,
): DuplicateVerdict {
  if (fileHashesMatch) {
    return { kind: 'confirmed', by: 'file_hash', detail: 'совпал хеш исходного файла' };
  }

  const aRows = candidate.items.length;
  const bRows = existing.items.length;
  const totals = cmp(money(candidate.totalSum), money(existing.totalSum));

  // Позиций нет ни у одного — сравнивать можно только по шапке, и тогда нужны
  // ОБА значения: одного итога мало, чтобы прятать документ.
  if (aRows === 0 && bRows === 0) {
    const vat = cmp(money(candidate.vatSum), money(existing.vatSum));
    if (totals === 'differs' || vat === 'differs') {
      return {
        kind: 'different',
        detail: `позиций нет, итоги разные: ${money(candidate.totalSum)} и ${money(existing.totalSum)}`,
      };
    }
    if (totals === 'equal' && vat === 'equal') {
      return { kind: 'confirmed', by: 'fingerprint', detail: 'позиций нет, совпали итог и НДС' };
    }
    return { kind: 'unknown', detail: 'позиций нет, а итогов не хватает для сравнения' };
  }

  // Позиции есть только у одного — это не различие документов, а разное
  // качество разбора. Прятать нельзя, но и объявлять разными неверно.
  if (aRows === 0 || bRows === 0) {
    return { kind: 'unknown', detail: 'у одного из разборов позиции не извлечены' };
  }

  if (aRows !== bRows) {
    return { kind: 'different', detail: `разное число позиций: ${aRows} и ${bRows}` };
  }
  if (totals === 'differs') {
    return {
      kind: 'different',
      detail: `разные итоги: ${money(candidate.totalSum)} и ${money(existing.totalSum)}`,
    };
  }

  // Построчно решают количество и сумма: первое — сколько материала приедет на
  // объект, второе — деньги. Цена и построчный НДС не решают намеренно: они
  // производные и как раз ломались синтезом ставки (см. bd3a6ce).
  let confirmedRows = 0;
  for (let idx = 0; idx < aRows; idx += 1) {
    const a = candidate.items[idx]!;
    const b = existing.items[idx]!;
    const qtyCmp = cmp(qty(a.qty), qty(b.qty));
    const sumCmp = cmp(money(a.sum), money(b.sum));
    if (qtyCmp === 'differs') {
      return {
        kind: 'different',
        detail: `строка ${idx + 1}: разное количество ${qty(a.qty)} и ${qty(b.qty)}`,
      };
    }
    if (sumCmp === 'differs') {
      return {
        kind: 'different',
        detail: `строка ${idx + 1}: разные суммы ${money(a.sum)} и ${money(b.sum)}`,
      };
    }
    if (qtyCmp === 'equal' || sumCmp === 'equal') confirmedRows += 1;
  }

  // Расхождений нет, но и подтверждать нечем: у строк не извлечены ни
  // количества, ни суммы. Совпадение реквизитов — не доказательство.
  if (totals !== 'equal' || confirmedRows < aRows) {
    return {
      kind: 'unknown',
      detail: `числа извлечены не полностью: подтверждено строк ${confirmedRows} из ${aRows}`,
    };
  }

  const sameText = textFingerprint(candidate) === textFingerprint(existing);
  return {
    kind: 'confirmed',
    by: 'fingerprint',
    detail: sameText
      ? `совпали шапка и все позиции (${aRows})`
      : `совпали итог, количества и суммы (${aRows} позиций); наименования прочитаны по-разному`,
  };
}
