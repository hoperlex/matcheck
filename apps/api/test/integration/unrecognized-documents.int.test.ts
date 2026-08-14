/**
 * Документ «не распознано»: выдача и завершение ручного разбора
 * (реальный PostgreSQL).
 *
 * Файл из ОБЯЗАТЕЛЬНОЙ зоны публичной формы, тип которого не подтвердили ни
 * классификатор, ни vision, получает документ-заглушку — иначе он исчезает из
 * виду. Заглушка не должна засорять рабочий список инспектора («Ожидаемые») и
 * обязана иметь явное завершение: без него она висит вечно и держит опрос
 * портала на 4 секундах.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('документ «не распознано» (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteId = randomUUID();
  const userId = randomUUID();
  const manager: AuthUser = { id: userId, role: 'manager', siteId: null } as unknown as AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', { updParse: { add: vi.fn() } } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = manager;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    await app.register(sourceDocumentRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`UNR${Date.now() % 10000}`}, 'Не распознано')`;
    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`unr-${userId}@test`}, 'x', 'manager')`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  });

  /** Документ в needs_resolution с заданным кодом — как его заводит router. */
  async function document(parseErrorCode: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO source_documents
        (kind, is_technical, direction, origin, status, site_id, queued_at, processed_at,
         parse_error_code, original_filename)
      VALUES ('upd', false, 'inbound', 'manual_pdf', 'needs_resolution', ${siteId}, now(), now(),
        ${parseErrorCode}, 'mystery.pdf')
      RETURNING id`;
    return row!.id;
  }

  it('«Ожидаемые» не показывают нераспознанное, но показывают частичное', async () => {
    // Экран КПП и приёмки запрашивает unaccepted=true без фильтра по статусу.
    // Заглушка там бесполезна — принять по ней нечего, а при массовой загрузке
    // фото такие строки забьют рабочий список. partial_parse — другое дело:
    // шапка распознана, не хватает позиций.
    const unrecognized = await document('unrecognized_type');
    const partial = await document('partial_parse');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/source-documents?kind=upd&unaccepted=true&limit=200',
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).not.toContain(unrecognized);
    expect(ids).toContain(partial);
  });

  it('в общем списке документ виден — иначе файл потерян', async () => {
    const id = await document('unrecognized_type');

    const res = await app.inject({ method: 'GET', url: '/api/v1/source-documents?limit=200' });
    const items = (res.json() as { items: Array<{ id: string; parseErrorCode: string | null }> })
      .items;
    expect(items.find((i) => i.id === id)?.parseErrorCode).toBe('unrecognized_type');
  });

  it('«Разобрано вручную» закрывает документ и отмечает строку реестра', async () => {
    const bundleId = randomUUID();
    await sql`INSERT INTO source_bundles (id, bundle_hash, kind, direction, site_id, status)
      VALUES (${bundleId}, ${randomUUID()}, 'mixed', 'inbound', ${siteId}, 'parsed')`;
    const id = await document('unrecognized_type');
    await sql`UPDATE source_documents SET bundle_id = ${bundleId} WHERE id = ${id}`;
    const [item] = await sql<{ id: string }[]>`
      INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, mime_type, size_bytes, upload_generation,
         status, effective_status, created_document_ids)
      VALUES (${bundleId}, 'mystery.pdf', ${`upload/${bundleId}/mystery.pdf`}, 'application/pdf',
        100, 0, 'created', 'created', ${JSON.stringify([id])}::jsonb)
      RETURNING id`;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${id}`,
      payload: { resolveManually: true },
    });

    expect(res.statusCode).toBe(200);
    // Реквизитов у заглушки нет, а ограничение source_upd_required не пускает
    // УПД в `parsed` без номера, даты и суммы. Поэтому закрытие «как есть» —
    // архив: документ уходит из работы, файл остаётся доступным.
    // Код ошибки НЕ очищается: по нему запись не уезжает на планшет КПП и не
    // попадает в «Ожидаемые», а менеджеру видно, почему документ в архиве.
    expect(res.json()).toMatchObject({
      status: 'archived',
      parseErrorCode: 'unrecognized_type',
    });
    const [row] = await sql<
      { resolved_at: Date | null; resolved_by_user_id: string | null; manual_document_id: string | null }[]
    >`SELECT resolved_at, resolved_by_user_id, manual_document_id
        FROM bundle_import_items WHERE id = ${item!.id}`;
    expect(row!.resolved_at).not.toBeNull();
    expect(row!.resolved_by_user_id).toBe(userId);
    expect(row!.manual_document_id).toBe(id);
  });

  it('с введёнными реквизитами документ закрывается как обработанный', async () => {
    // Обратный случай: файл всё-таки был документом, менеджер ввёл номер, дату
    // и сумму — тогда закрытие даёт полноценный `parsed`.
    const id = await document('unrecognized_type');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${id}`,
      payload: {
        resolveManually: true,
        docNumber: 'УПД-77',
        docDate: '2026-08-01',
        totalSum: '1000.00',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'parsed', parseErrorCode: null });
  });

  it('чужой код ошибки флагом не закрывается', async () => {
    // Флаг создан для заглушек. Дубликат закрывается своим диалогом
    // (заменить/пропустить), а не кнопкой «разобрано».
    const id = await document('duplicate_upd');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${id}`,
      payload: { resolveManually: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'needs_resolution',
      parseErrorCode: 'duplicate_upd',
    });
  });

  it('прочие заглушки ведут себя так же: скрыты в «Ожидаемых», видны в списке', async () => {
    // Кодов у заглушки теперь несколько: накладную не смог прочитать парсер,
    // файл не дошёл до разбора, сертификат распознавать не требуется. Ведут
    // себя они одинаково — иначе поведение зависело бы от того, на каком шаге
    // сорвался разбор.
    const waybill = await document('no_waybill_found');
    const notProcessed = await document('not_processed');
    const supplementary = await document('supplementary');
    // Сопроводительный заводится сразу архивным: разбирать в нём нечего.
    await sql`UPDATE source_documents SET status = 'archived' WHERE id = ${supplementary}`;

    const expected = await app.inject({
      method: 'GET',
      url: '/api/v1/source-documents?kind=upd&unaccepted=true&limit=200',
    });
    const expectedIds = (expected.json() as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(expectedIds).not.toContain(waybill);
    expect(expectedIds).not.toContain(notProcessed);
    expect(expectedIds).not.toContain(supplementary);

    const all = await app.inject({ method: 'GET', url: '/api/v1/source-documents?limit=200' });
    const allIds = (all.json() as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(allIds).toEqual(expect.arrayContaining([waybill, notProcessed, supplementary]));
  });

  it('документ со сломавшимся разбором из «Ожидаемых» не пропадает', async () => {
    // Граница отбора: заглушка — это пара (статус, код). У обычного документа,
    // разбор которого сорвался, статус parse_failed, и прятать его нельзя —
    // менеджер по нему работает.
    const [broken] = await sql<{ id: string }[]>`
      INSERT INTO source_documents
        (kind, is_technical, direction, origin, status, site_id, queued_at, processed_at,
         parse_error_code, original_filename)
      VALUES ('upd', false, 'inbound', 'manual_pdf', 'parse_failed', ${siteId}, now(), now(),
        'not_processed', 'broken.pdf')
      RETURNING id`;

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/source-documents?kind=upd&unaccepted=true&limit=200',
    });
    const ids = (res.json() as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).toContain(broken!.id);
  });

  it('накладная закрывается без суммы: её в документе может не быть вовсе', async () => {
    // CHECK source_upd_required требует сумму только с УПД. Требовать её с
    // накладной значило бы навсегда запереть такой документ в архиве.
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO source_documents
        (kind, is_technical, direction, origin, status, site_id, queued_at, processed_at,
         parse_error_code, original_filename)
      VALUES ('transport_waybill', false, 'inbound', 'manual_pdf', 'needs_resolution', ${siteId},
        now(), now(), 'no_waybill_found', 'wb.jpg')
      RETURNING id`;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${row!.id}`,
      payload: { resolveManually: true, docNumber: 'ТН-5', docDate: '2026-08-01' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'parsed', parseErrorCode: null });
  });

  it('исходник заглушки реально скачивается через /file/raw', async () => {
    // Видимая строка без доступного файла ничего не стоит: ради файла всё и
    // затевалось. Проверяем именно поток через бэкенд, а не выдачу ссылки:
    // маршрут `/file` только подписывает URL и наличие объекта не проверяет.
    const id = await document('no_waybill_found');
    const s3Key = `upload/${id}/wb.jpg`;
    await sql`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, size_bytes, role)
      VALUES (${id}, ${s3Key}, 'wb.jpg', 'image/jpeg', 12, 'original')`;

    const body = Buffer.from('jpeg-bytes');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      );

    try {
      const res = await app.inject({ method: 'GET', url: `/api/v1/source-documents/${id}/file/raw` });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(body)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('поиск находит заглушку по имени файла — номера у неё нет', async () => {
    // Поиск шёл только по doc_number, поэтому любой непустой запрос прятал
    // ровно те документы, которые менеджер и ищет глазами по названию файла.
    const id = await document('unrecognized_type');
    await sql`UPDATE source_documents SET original_filename = 'скан-квитанции.pdf' WHERE id = ${id}`;

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/source-documents?q=квитанц&limit=200',
    });
    const ids = (res.json() as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).toContain(id);
  });
});
