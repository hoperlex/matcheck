/**
 * Маршрут POST /source-documents/:id/reparse.
 *
 * Проверяется граница, за которую отвечает API, а не воркер:
 *   * повтор ставится атомарно — поколение, состояние документа и задание в
 *     outbox появляются одной транзакцией;
 *   * снимок «что было до» сохраняется, а прежняя диагностика при этом НЕ
 *     гасится: её погасит только успешный разбор, иначе неудачный повтор стёр
 *     бы её без замены;
 *   * документ, уже стоящий в очереди, второго задания не получает;
 *   * исходный файл не трогается вовсе — это прямое требование к фиче.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';
import { dispatchKeyOf } from '../../src/domain/jobs/job-outbox.js';

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: vi.fn(),
  presign: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('повторное распознавание: маршрут (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteId = randomUUID();
  const admin = { id: randomUUID(), role: 'admin', siteId: null } as unknown as AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', { updParse: { add: vi.fn() } } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = admin;
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
              VALUES (${siteId}, ${`RPA${Date.now() % 10000}`}, 'Повтор API')`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await cleanup();
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM job_outbox WHERE payload->>'sourceDocumentId' IN (
      SELECT id::text FROM source_documents WHERE site_id = ${siteId})`;
    await sql`DELETE FROM source_document_attachments WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
  }

  beforeEach(cleanup);

  async function seedDoc(
    over: { status?: string; isTechnical?: boolean; withFile?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO source_documents
        (id, kind, direction, status, origin, site_id, is_technical, doc_number, doc_date,
         total_sum, parse_error_code, validation, processed_at)
      VALUES (${id}, 'upd', 'inbound', ${over.status ?? 'parsed'}, 'manual_pdf', ${siteId},
              ${over.isTechnical ?? false}, 'API-1', '2026-06-01', '100.00',
              'validation_mismatch',
              ${JSON.stringify({ hasMismatch: true, checks: [], checkedAt: '2026-06-01' })}::jsonb,
              now())`;
    if (over.withFile ?? true) {
      await sql`INSERT INTO source_document_attachments
          (source_document_id, s3_key, filename, mime_type, role)
        VALUES (${id}, ${`upload/${id}.pdf`}, 'doc.pdf', 'application/pdf', 'original')`;
    }
    return id;
  }

  const reparse = (id: string) =>
    app.inject({ method: 'POST', url: `/api/v1/source-documents/${id}/reparse` });

  async function docRow(id: string) {
    const [r] = await sql<
      {
        status: string;
        dispatch_generation: number;
        job_id: string | null;
        parse_error_code: string | null;
        validation: unknown;
        reparse: { state?: string; generation?: number; snapshot?: Record<string, unknown> } | null;
      }[]
    >`SELECT status, dispatch_generation, job_id, parse_error_code, validation, reparse
        FROM source_documents WHERE id = ${id}`;
    return r!;
  }

  it('ставит задание и поднимает поколение', async () => {
    const id = await seedDoc();

    const res = await reparse(id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, plan: 'single' });

    const r = await docRow(id);
    expect(r.status).toBe('queued');
    expect(r.dispatch_generation).toBe(1);
    expect(r.job_id).toBe(dispatchKeyOf(id, 1));

    const jobs = await sql<{ dedupe_key: string; payload: Record<string, unknown> }[]>`
      SELECT dedupe_key, payload FROM job_outbox WHERE payload->>'sourceDocumentId' = ${id}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.dedupe_key).toBe(dispatchKeyOf(id, 1));
    expect(jobs[0]!.payload).toMatchObject({ sourceDocumentId: id, docGeneration: 1 });
  });

  it('снимок сохранён, а прежняя диагностика оставлена до успешного разбора', async () => {
    const id = await seedDoc();

    await reparse(id);

    const r = await docRow(id);
    expect(r.reparse).toMatchObject({ state: 'queued', generation: 1 });
    expect(r.reparse?.snapshot).toMatchObject({
      status: 'parsed',
      parseErrorCode: 'validation_mismatch',
    });
    // Ключевое: код ошибки и validation НЕ обнулены. Если повтор не удастся,
    // откатывать будет к чему.
    expect(r.parse_error_code).toBe('validation_mismatch');
    expect(r.validation).not.toBeNull();
  });

  it('исходный файл не трогается', async () => {
    const id = await seedDoc();
    const before = await sql`SELECT s3_key, filename, role FROM source_document_attachments
                               WHERE source_document_id = ${id}`;

    await reparse(id);

    const after = await sql`SELECT s3_key, filename, role FROM source_document_attachments
                              WHERE source_document_id = ${id}`;
    expect(after).toEqual(before);
  });

  it('документ уже в очереди — второго задания не будет', async () => {
    const id = await seedDoc({ status: 'queued' });

    const res = await reparse(id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_running');
    const jobs = await sql`SELECT 1 FROM job_outbox WHERE payload->>'sourceDocumentId' = ${id}`;
    expect(jobs).toHaveLength(0);
  });

  it('без исходного файла повторять нечего', async () => {
    const id = await seedDoc({ withFile: false });

    const res = await reparse(id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_attachment');
    // Документ не тронут: ни статуса, ни поколения.
    const r = await docRow(id);
    expect(r.status).toBe('parsed');
    expect(r.dispatch_generation).toBe(0);
  });

  it('служебная запись пакета снаружи не существует', async () => {
    const id = await seedDoc({ isTechnical: true });

    const res = await reparse(id);

    expect(res.statusCode).toBe(404);
  });

  it('повторное нажатие после разбора даёт СЛЕДУЮЩЕЕ поколение', async () => {
    const id = await seedDoc();
    await reparse(id);
    // Разбор завершился — документ снова доступен для повтора.
    await sql`UPDATE source_documents SET status = 'parsed' WHERE id = ${id}`;

    const res = await reparse(id);

    expect(res.statusCode).toBe(200);
    const r = await docRow(id);
    expect(r.dispatch_generation).toBe(2);
    // Два разных ключа: BullMQ держит завершённые задания сутки, и повтор с
    // прежним ключом молча не запустился бы.
    const keys = await sql<{ dedupe_key: string }[]>`
      SELECT dedupe_key FROM job_outbox WHERE payload->>'sourceDocumentId' = ${id}
       ORDER BY dedupe_key`;
    expect(keys.map((k) => k.dedupe_key)).toEqual([dispatchKeyOf(id, 1), dispatchKeyOf(id, 2)]);
  });
});
