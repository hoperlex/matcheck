// Кто ещё держит объект в S3.
//
// Ключ не принадлежит документу единолично: один и тот же объект штатно делят
// несколько source_documents. Пачка накладных дублирует attachments на каждый
// созданный документ (S3-файл общий, в junction-таблице — новые строки), сборка
// УПД раздаёт страницы одного PDF разным документам, а слияние дубликатов
// копирует вложения на keeper, сохраняя строки скрытых документов.
//
// Поэтому «документ удалён» ≠ «файл больше не нужен»: удаление одного документа
// из пачки не должно уносить PDF у живых соседей. Junction-строки уходят
// каскадом вместе с документом, значит оставшаяся строка — это живой владелец.
//
// Отдельный модуль, а не функция в worker.ts: тот на верхнем уровне поднимает
// очередь, BullMQ-воркеров и интервальные задачи, и импортировать его ради
// проверки (в том числе из теста) значило бы запустить их все.
import { inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { sourceDocumentAttachments } from '../../db/schema.js';

/**
 * Из переданных ключей возвращает те, на которые не осталось ни одной ссылки.
 *
 * Дубликаты во входном списке схлопываются: очередь чистки получает ключи как
 * есть, а один документ может держать один и тот же объект несколькими ролями.
 */
export async function selectUnreferencedS3Keys(db: Db, keys: string[]): Promise<string[]> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return [];

  const rows = await db
    .selectDistinct({ s3Key: sourceDocumentAttachments.s3Key })
    .from(sourceDocumentAttachments)
    .where(inArray(sourceDocumentAttachments.s3Key, unique));

  const stillReferenced = new Set(rows.map((r) => r.s3Key));
  return unique.filter((k) => !stillReferenced.has(k));
}
