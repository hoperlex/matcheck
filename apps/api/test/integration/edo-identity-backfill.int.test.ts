/**
 * Разовое заполнение признаков тождества для старых строк реестра — на
 * настоящем PostgreSQL, хранилище подменено.
 *
 * Обещания:
 *   - пробный подсчёт ничего не пишет;
 *   - пишутся только file_id и content_key, теми же функциями, что и запись;
 *   - файл, не совпавший с принятым (sha256), сбой хранилища и сбой разбора —
 *     в отчёт, строка не тронута;
 *   - строка, перезаписанная за время чтения, не тронута;
 *   - уже заполненные и не выгруженные строки не читаются; повтор безопасен.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import { contentKeyOf, fileIdOf } from '../../src/domain/edo/export-identity.js';
import { backfillExportIdentity } from '../../src/domain/edo/identity-backfill.js';
import { decodeXmlBuffer } from '../../src/domain/edo/upd-xml-decode.js';
import { parseUpdXml } from '../../src/domain/edo/upd.parser.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const xml = (number: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR_${number}" ВерсФорм="5.03">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерДок="${number}" ДатаДок="10.03.2031">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО «Терма Альянс»" ИННЮЛ="5009091604" КПП="500901001"/></ИдСв></СвПрод>
    </СвСчФакт>
    <ТаблСчФакт>
      <СведТов НомСтр="1" НаимТов="Труба ПП 20" НаимЕдИзм="м" КолТов="40" ЦенаТов="50"
               СтТовБезНДС="2000" НалСт="20%" СтТовУчНал="2400">
        <СумНал><СумНал>400</СумНал></СумНал>
      </СведТов>
      <ВсегоОпл СтТовБезНДСВсего="2000" СтТовУчНалВсего="2400"><СумНалВсего><СумНал>400</СумНал></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

suite('признаки тождества для старых строк реестра (реальный PostgreSQL)', { timeout: 60_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  const accountId = randomUUID();
  const RUN = String(Date.now()).slice(-6);
  const files = new Map<string, Buffer | Error>();
  const getObject = vi.fn(async (key: string) => {
    const f = files.get(key);
    if (!f) throw new Error(`нет объекта ${key}`);
    if (f instanceof Error) throw f;
    return f;
  });

  async function row(o: {
    key: string;
    body?: Buffer | Error;
    sha?: string | null;
    status?: string;
    fileId?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    if (o.body) files.set(o.key, o.body);
    const contentSha = o.sha !== undefined ? o.sha : o.body instanceof Buffer ? sha(o.body) : 'f'.repeat(64);
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, status, s3_key, content_sha256,
         file_id, received_at)
      VALUES (${id}, ${accountId}, ${`m-${id}`}, ${`e-${id}`}, 'UniversalTransferDocument',
              ${o.status ?? 'stored'}, ${o.status === 'failed' ? null : o.key}, ${o.status === 'failed' ? null : contentSha},
              ${o.fileId ?? null}, now())`;
    return id;
  }
  const keysOf = async (id: string) =>
    (await sql<{ fid: string | null; ck: string | null }[]>`
      SELECT file_id AS fid, content_key AS ck FROM edo_export_documents WHERE id = ${id}`)[0]!;

  let good: string;
  let goodBody: Buffer;
  let mismatch: string;
  let s3Down: string;
  let broken: string;
  let filledAlready: string;
  let raced: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted, box_id)
              VALUES (${accountId}, ${`Backfill ${RUN}`}, '{}', ${`box-${RUN}`})`;
    goodBody = Buffer.from(xml(`БФ-${RUN}1`), 'utf8');
    good = await row({ key: `bf/${RUN}/good.xml`, body: goodBody });
    mismatch = await row({ key: `bf/${RUN}/mismatch.xml`, body: Buffer.from(xml(`БФ-${RUN}2`)), sha: 'a'.repeat(64) });
    s3Down = await row({ key: `bf/${RUN}/down.xml`, body: new Error('S3 GET failed: HTTP 503') });
    broken = await row({ key: `bf/${RUN}/broken.xml`, body: Buffer.from('<не xml') });
    filledAlready = await row({ key: `bf/${RUN}/filled.xml`, body: Buffer.from(xml(`БФ-${RUN}3`)), fileId: 'ON_KNOWN' });
    await row({ key: `bf/${RUN}/failed.xml`, status: 'failed' });
    const racedBody = Buffer.from(xml(`БФ-${RUN}4`), 'utf8');
    raced = await row({ key: `bf/${RUN}/raced.xml`, body: racedBody });
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM edo_export_documents WHERE edo_account_id = ${accountId}`;
    await sql`DELETE FROM edo_accounts WHERE id = ${accountId}`;
    await sql.end({ timeout: 5 });
  });

  it('пробный подсчёт: отчёт полный, в базе ничего не меняется', async () => {
    const report = await backfillExportIdentity({ db, getObject, apply: false, accountId });
    expect(report).toMatchObject({ scanned: 5, filled: 2, withFileId: 2, withContentKey: 2, noKeys: 0, changed: 0 });
    expect(new Set(report.failures.map((f) => f.id))).toEqual(new Set([mismatch, s3Down, broken]));
    expect(report.failures.find((f) => f.id === mismatch)?.reason).toContain('sha256');
    expect(await keysOf(good)).toEqual({ fid: null, ck: null });
    // Заполненную и не выгруженную строки не читали.
    expect(getObject).not.toHaveBeenCalledWith(`bf/${RUN}/filled.xml`);
    expect(getObject).not.toHaveBeenCalledWith(`bf/${RUN}/failed.xml`);
  });

  it('запись: только два поля, теми же функциями; сбойные не тронуты; повтор безопасен', async () => {
    const report = await backfillExportIdentity({ db, getObject, apply: true, accountId, concurrency: 1 });
    expect(report).toMatchObject({ scanned: 5, filled: 2, changed: 0 });

    const parsed = parseUpdXml(decodeXmlBuffer(goodBody));
    expect(fileIdOf(parsed)).toBe(`ON_NSCHFDOPPR_БФ-${RUN}1`);
    expect(await keysOf(good)).toEqual({ fid: fileIdOf(parsed), ck: contentKeyOf(parsed) });
    expect((await keysOf(raced)).ck).toMatch(/^[0-9a-f]{64}$/);
    for (const id of [mismatch, s3Down, broken]) expect(await keysOf(id)).toEqual({ fid: null, ck: null });
    expect(await keysOf(filledAlready)).toEqual({ fid: 'ON_KNOWN', ck: null });
    // Остальные поля строки не тронуты.
    const other = (await sql<{ s: string; sha: string | null }[]>`
      SELECT status AS s, content_sha256 AS sha FROM edo_export_documents WHERE id = ${good}`)[0]!;
    expect(other).toEqual({ s: 'stored', sha: sha(goodBody) });

    // Повтор: заполненные строки больше не берутся, сбойные — берутся снова.
    getObject.mockClear();
    const again = await backfillExportIdentity({ db, getObject, apply: true, accountId });
    expect(again).toMatchObject({ scanned: 3, filled: 0 });
    expect(getObject).not.toHaveBeenCalledWith(`bf/${RUN}/good.xml`);
  });

  it('строка перезаписана между чтением файла и записью — условие UPDATE её не трогает', async () => {
    const body = Buffer.from(xml(`БФ-${RUN}5`), 'utf8');
    const id = await row({ key: `bf/${RUN}/late.xml`, body });
    const original = getObject.getMockImplementation()!;
    getObject.mockImplementation(async (key: string) => {
      const out = await original(key);
      // Файл прочитан верный, а строку тем временем перевели в сбой повтора.
      if (key === `bf/${RUN}/late.xml`) {
        await sql`UPDATE edo_export_documents SET status = 'failed' WHERE id = ${id}`;
      }
      return out;
    });
    const report = await backfillExportIdentity({ db, getObject, apply: true, accountId });
    getObject.mockImplementation(original);
    expect(report.changed).toBe(1);
    expect(await keysOf(id)).toEqual({ fid: null, ck: null });
  });
});
