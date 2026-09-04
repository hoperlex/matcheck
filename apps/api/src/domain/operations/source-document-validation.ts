/**
 * Сводка сверки документа для карточки и списка операций.
 *
 * Зачем отдельный модуль. Валидатор (`domain/edo/upd-validation.ts`) считает
 * полный снимок и хранит его в `source_documents.validation`; показывать этот
 * снимок целиком в операциях нельзя — он весит в среднем 1,7 КБ, а на худшем
 * документе 64 КБ, и список отдаёт десятки документов за раз. Здесь снимок
 * сужается до того, что менеджер действительно читает.
 *
 * Кому это адресовано. Замечания в приёмках оставляет роль monitor, а
 * `documents.list:view` есть только у manager и contractor: уйти за
 * подробностями в раздел «Документы» монитор не может. Поэтому сводка несёт и
 * числа, и подозрения — она для него единственный источник.
 */

import { asc, inArray } from 'drizzle-orm';
import type {
  OperationDocumentValidation,
  UpdCheck,
  UpdValidation,
  UpdWarning,
} from '@matcheck/contracts';
import { sourceDocumentItems } from '../../db/schema.js';

/** Номер строки из области проверки; для документных проверок — null. */
function rowOf(scope: UpdCheck['scope'] | UpdWarning['scope']): number | null {
  return scope === 'document' ? null : scope.row;
}

/**
 * Сколько позиций было в списке на момент снимка.
 *
 * `items_count` валидатор пишет ВСЕГДА, даже когда сверять не с чем: в
 * `actual` там лежит фактическое число разобранных строк. Это и есть дешёвый
 * способ понять, описывает ли снимок тот же список позиций, что лежит в базе
 * сейчас (после переразбора или ручной правки он мог разъехаться).
 */
function snapshotRowCount(validation: UpdValidation): number | null {
  const check = validation.checks.find((c) => c.name === 'items_count');
  return check?.actual ?? null;
}

/**
 * Сужает снимок валидации до сводки для операции.
 *
 * Возвращает `undefined`, когда показывать нечего — тогда поля в DTO не будет
 * вовсе, и ответ останется байт-в-байт прежним. Это и есть no-op-гарантия:
 * здоровые документы (а их большинство) не меняют ни форму ответа, ни его вес.
 *
 * @param validation снимок из `source_documents.validation`
 * @param rowItemIds id позиций документа В ПОРЯДКЕ `line_no`; индекс i
 *   соответствует `scope.row === i + 1`. Передавать только для документов, у
 *   которых есть построчные проблемы, — иначе лишний запрос в базу.
 */
export function summarizeForOperation(
  validation: UpdValidation | null | undefined,
  rowItemIds?: readonly string[],
): OperationDocumentValidation | undefined {
  if (validation == null) return undefined;

  // Пропущенные проверки (`skipReason`) — не проблема, а «сверять было не с
  // чем»: у строки нет цены или суммы. Показывать их менеджеру нечего.
  const failedChecks = validation.checks.filter((c) => !c.ok && c.skipReason === undefined);
  const warnings = validation.warnings ?? [];
  if (failedChecks.length === 0 && warnings.length === 0) return undefined;

  const rows = [
    ...new Set(
      [...failedChecks, ...warnings]
        .map((entry) => rowOf(entry.scope))
        .filter((row): row is number => row !== null),
    ),
  ].sort((a, b) => a - b);

  return {
    hasMismatch: validation.hasMismatch,
    failedChecks,
    warnings,
    problemItemIds: resolveProblemItemIds(validation, rows, rowItemIds),
  };
}

/**
 * Переводит номера проблемных строк в id позиций документа.
 *
 * Guard на устаревший снимок: если число позиций в снимке не сходится с тем,
 * что лежит в базе сейчас, или номер строки выходит за границы списка, —
 * возвращаем пустой массив. Текст сводки при этом остаётся: лучше сказать
 * «строка 2 не сходится» без подсветки, чем подсветить чужую строку. На боевых
 * данных guard срабатывает на 2 документах из 2299.
 */
function resolveProblemItemIds(
  validation: UpdValidation,
  rows: readonly number[],
  rowItemIds?: readonly string[],
): string[] {
  if (rowItemIds === undefined || rows.length === 0) return [];

  const snapshotCount = snapshotRowCount(validation);
  if (snapshotCount !== null && snapshotCount !== rowItemIds.length) return [];
  if (rows.some((row) => row > rowItemIds.length)) return [];

  return rows.map((row) => rowItemIds[row - 1]).filter((id): id is string => id !== undefined);
}

/**
 * Есть ли у снимка построчные проблемы — то есть нужно ли вообще идти в базу за
 * id позиций. Документные расхождения (`sum_total`, `vat_total`) адреса строки
 * не имеют, и ради них запрос делать незачем.
 */
export function hasRowScopedProblems(validation: UpdValidation | null | undefined): boolean {
  if (validation == null) return false;
  const failed = validation.checks.filter((c) => !c.ok && c.skipReason === undefined);
  return [...failed, ...(validation.warnings ?? [])].some((entry) => rowOf(entry.scope) !== null);
}

/**
 * Грузит id позиций документов В ПОРЯДКЕ `line_no` — для подсветки строк.
 *
 * Вызывать ТОЛЬКО для документов, у которых есть построчные проблемы: у
 * здорового документа (а их большинство) запроса не будет вовсе, и ответ
 * останется прежним по весу. Отбор делает `hasRowScopedProblems`.
 *
 * Порядок задаёт сортировка по `line_no`, а не значение `line_no`: индекс в
 * массиве — это и есть `scope.row - 1`. На боевых данных они сегодня совпадают
 * (11 724 строки, ноль расхождений), но полагаться на совпадение нельзя —
 * нумерация принадлежит разбору, а не карточке.
 */
export async function loadProblemRowItemIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  documentIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (documentIds.length === 0) return result;

  const rows: { sourceDocumentId: string; id: string }[] = await db
    .select({
      sourceDocumentId: sourceDocumentItems.sourceDocumentId,
      id: sourceDocumentItems.id,
    })
    .from(sourceDocumentItems)
    .where(inArray(sourceDocumentItems.sourceDocumentId, [...documentIds]))
    .orderBy(asc(sourceDocumentItems.sourceDocumentId), asc(sourceDocumentItems.lineNo));

  for (const row of rows) {
    const list = result.get(row.sourceDocumentId);
    if (list) list.push(row.id);
    else result.set(row.sourceDocumentId, [row.id]);
  }
  return result;
}

/**
 * Документы страницы, для которых подсветка вообще имеет смысл.
 *
 * Отдельная функция, чтобы оба пути DTO (одиночный и батч) и обе операции
 * (приёмки и отгрузки) отбирали их одинаково — иначе форма ответа разъедется
 * ровно там, где её труднее всего заметить.
 */
export function documentsNeedingRowIds(
  rows: readonly { id: string; validation: UpdValidation | null }[],
): string[] {
  return rows.filter((r) => hasRowScopedProblems(r.validation)).map((r) => r.id);
}

/**
 * Текст для колонки выгрузки: что именно в документе требует проверки.
 *
 * Тот же признак, что у фильтра `doc_attention` и у плашки, — расхождение ИЛИ
 * подозрение. Если бы выгрузка считала его по-своему, «отфильтровал и выгрузил»
 * давало бы разные наборы строк, и доверия к обоим не осталось бы.
 *
 * Пустая строка (а не «нет») у здорового документа: колонка читается глазами по
 * непустым ячейкам, и слово «нет» в тысяче строк только мешает.
 */
export function describeDocAttention(validation: UpdValidation | null | undefined): string {
  const summary = summarizeForOperation(validation);
  if (!summary) return '';
  const parts: string[] = [];
  if (summary.failedChecks.length > 0) parts.push(`расхождений: ${summary.failedChecks.length}`);
  if (summary.warnings.length > 0) parts.push(`подозрений: ${summary.warnings.length}`);
  return parts.join(', ');
}
