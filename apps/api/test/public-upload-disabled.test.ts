/**
 * Публичный вход выключен по умолчанию.
 *
 * Свойство важнее, чем кажется: роуты регистрируются всегда, и если бы флаг
 * читался небрежно, фича включилась бы на проде сама собой при первом же
 * деплое — открытый приём файлов в S3 без единой строки в env.
 *
 * Отдельный файл, потому что loadEnv кэширует значение на процесс: включённое
 * состояние проверяется в test/integration/public-upload.int.test.ts.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/domain/storage/s3.signer.js', () => ({
  putObject: vi.fn(),
  presign: vi.fn(),
}));

// Переменная НЕ задана — ровно та ситуация, что на свежем сервере.
delete process.env.PUBLIC_UPLOAD_ENABLED;

const { publicUploadRoutes } = await import('../src/routes/public-upload.js');

describe('PUBLIC_UPLOAD_ENABLED по умолчанию', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart);
    app.decorate('db', {} as never);
    app.decorate('queues', { updParse: { add: vi.fn() } } as never);
    app.decorate('createRateLimit', () => async () => ({ isAllowed: true, key: 'test' }) as never);
    await app.register(publicUploadRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('справочник объектов недоступен', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/sites' });
    // 404, а не 403: существование страницы наружу не подтверждаем.
    expect(res.statusCode).toBe(404);
  });

  it('загрузка недоступна', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/public/upload-documents',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      payload: '--x--\r\n',
    });
    expect(res.statusCode).toBe(404);
  });

  it('статус обращения недоступен', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/upload-documents/aaaaaaaaaaaaaaaa',
    });
    expect(res.statusCode).toBe(404);
  });
});
