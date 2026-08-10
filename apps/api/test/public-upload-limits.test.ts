/**
 * Сбор multipart для загрузки документов: лимиты и входной фильтр.
 *
 * Два режима одной функции проверяются вместе намеренно:
 *   * `legacy` — внутренний вход менеджера. Его поведение фиксировано
 *     characterization-тестами и меняться не должно: неподдерживаемые файлы
 *     отбрасываются МОЛЧА, пустые не считаются файлами.
 *   * `strict` — публичный вход от неизвестного отправителя. Тип определяется
 *     по содержимому, отказ объясняется человеку.
 *
 * Отдельно проверяется, что превышение лимитов даёт типизированный отказ, а не
 * исключение: общий error-handler намеренно игнорирует err.statusCode, поэтому
 * непойманная ошибка multipart превращается в 500 «reach files limit».
 *
 * В конце файла — отдельный набор про НАСТОЯЩИЙ @fastify/rate-limit на роуте
 * публичной загрузки. Он живёт здесь, а не в интеграционных тестах, потому что
 * не требует ни Postgres, ни S3 и должен гоняться на каждом прогоне.
 */
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectUploadParts,
  type CollectMode,
  type CollectResult,
  type UploadLimits,
} from '../src/domain/sourceDocuments/collect-upload.js';
import { publicUploadRoutes } from '../src/routes/public-upload.js';
import { PublicRejectReasonSchema } from '@matcheck/contracts';

const BOUNDARY = '----matcheckLimits';

function multipartBody(
  fields: Record<string, string>,
  files: Array<{ field: string; filename: string; contentType: string; content: Buffer }>,
): { body: Buffer; headers: Record<string, string> } {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${f.field}"; ` +
          `filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    body: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

const DEFAULT_LIMITS: UploadLimits = {
  maxFiles: 3,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxFields: 5,
  maxFieldBytes: 1024,
  maxParts: 20,
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function run(
  mode: CollectMode,
  fields: Record<string, string>,
  files: Array<{ field: string; filename: string; contentType: string; content: Buffer }>,
  limits: Partial<UploadLimits> = {},
): Promise<CollectResult> {
  app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  let captured: CollectResult | undefined;
  app.post('/t', async (req) => {
    captured = await collectUploadParts(req, { ...DEFAULT_LIMITS, ...limits }, mode);
    return { ok: true };
  });
  const { body, headers } = multipartBody(fields, files);
  await app.inject({ method: 'POST', url: '/t', payload: body, headers });
  if (!captured) throw new Error('collector не отработал');
  return captured;
}

function pdf(marker = 'x'): Buffer {
  return Buffer.from(`%PDF-1.4\n%${marker}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`);
}

function jpeg(sizeBytes: number): Buffer {
  const buf = Buffer.alloc(sizeBytes, 0x20);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}

/** Минимальный ZIP с заданными именами записей (central directory + EOCD). */
function zipWith(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBuf = Buffer.from(name, 'latin1');
    const content = Buffer.from(`<${name}/>`);
    const compressed = deflateRawSync(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

describe('collectUploadParts — поля и файлы за один проход', () => {
  it('поля возвращаются вместе с файлами', async () => {
    const res = await run(
      'strict',
      { siteId: 'S-1', expectedDate: '2026-08-06', comment: 'вторая машина' },
      [{ field: 'files', filename: 'a.pdf', contentType: 'application/pdf', content: pdf() }],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields).toMatchObject({ siteId: 'S-1', comment: 'вторая машина' });
    expect(res.accepted).toHaveLength(1);
  });

  it('поля читаются, даже когда идут ПОСЛЕ файлов', async () => {
    // Наш фронт кладёт поля первыми, но чужой клиент не обязан: прежний код
    // брал поля из последней файловой части и такую форму терял.
    app = Fastify({ logger: false });
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    let captured: CollectResult | undefined;
    app.post('/t', async (req) => {
      captured = await collectUploadParts(req, DEFAULT_LIMITS, 'strict');
      return { ok: true };
    });
    const parts = [
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; ` +
          `filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      pdf(),
      Buffer.from('\r\n'),
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="siteId"\r\n\r\nLATE\r\n`,
      ),
      Buffer.from(`--${BOUNDARY}--\r\n`),
    ];
    await app.inject({
      method: 'POST',
      url: '/t',
      payload: Buffer.concat(parts),
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    });
    expect(captured?.ok).toBe(true);
    if (!captured?.ok) return;
    expect(captured.fields.siteId).toBe('LATE');
  });

  it('имя части задаёт режим: extraFiles — только сохранить, остальные — распознавать', async () => {
    // Режим едет именем части, потому что текстовые поля читаются раньше
    // файлов и пофайловый признак отдельным полем не выразить. Умолчание
    // важно: мобильный клиент и старые сборки веба шлют одно поле `files`.
    const res = await run('strict', {}, [
      { field: 'files', filename: 'upd.pdf', contentType: 'application/pdf', content: pdf('1') },
      { field: 'extraFiles', filename: 'cert.pdf', contentType: 'application/pdf', content: pdf('2') },
      { field: 'attachment', filename: 'other.pdf', contentType: 'application/pdf', content: pdf('3') },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted.map((f) => [f.filename, f.processingMode])).toEqual([
      ['upd.pdf', 'auto'],
      ['cert.pdf', 'store_only'],
      ['other.pdf', 'auto'],
    ]);
  });
});

describe('collectUploadParts — лимиты дают отказ, а не исключение', () => {
  it('слишком много файлов', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      field: 'files',
      filename: `f${i}.pdf`,
      contentType: 'application/pdf',
      content: pdf(String(i)),
    }));
    const res = await run('strict', {}, files);
    expect(res).toEqual({ ok: false, error: 'too_many_files' });
  });

  it('файл больше лимита', async () => {
    const res = await run(
      'strict',
      {},
      [{ field: 'files', filename: 'big.jpg', contentType: 'image/jpeg', content: jpeg(200_000) }],
      { maxFileBytes: 50_000 },
    );
    expect(res).toEqual({ ok: false, error: 'file_too_large' });
  });

  it('суммарный объём больше лимита', async () => {
    const res = await run(
      'strict',
      {},
      [
        { field: 'files', filename: 'a.jpg', contentType: 'image/jpeg', content: jpeg(60_000) },
        { field: 'files', filename: 'b.jpg', contentType: 'image/jpeg', content: jpeg(60_000) },
      ],
      { maxTotalBytes: 100_000 },
    );
    expect(res).toEqual({ ok: false, error: 'total_too_large' });
  });

  it('слишком много полей', async () => {
    const fields = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`f${i}`, 'v']),
    ) as Record<string, string>;
    const res = await run('strict', fields, [], { maxFields: 3 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(['too_many_fields', 'malformed']).toContain(res.error);
  });
});

describe('collectUploadParts — режим strict (публичный вход)', () => {
  it('исполняемый файл под именем .pdf не проходит', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(60_000, 0x41)]);
    const res = await run('strict', {}, [
      { field: 'files', filename: 'счёт.pdf', contentType: 'application/pdf', content: exe },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected).toEqual([{ filename: 'счёт.pdf', reason: 'unsupported_type' }]);
  });

  it('docx, переименованный в .xlsx, не проходит как книга Excel', async () => {
    // Любой zip определяется по сигнатуре как xlsx — отличает только состав.
    const docx = zipWith(['[Content_Types].xml', 'word/document.xml']);
    const res = await run('strict', {}, [
      {
        field: 'files',
        filename: 'накладная.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: docx,
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected[0]).toMatchObject({ reason: 'unsupported_type' });
  });

  it('настоящая книга xlsx проходит', async () => {
    const xlsx = zipWith(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const res = await run('strict', {}, [
      {
        field: 'files',
        filename: 'упд.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: xlsx,
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted).toHaveLength(1);
  });

  it('старый .xls (OLE2) публично не принимается', async () => {
    // Та же сигнатура у .doc и .ppt — различить их без разбора потока нельзя,
    // а ради редкого формата это не окупается.
    const ole2 = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(60_000, 0),
    ]);
    const res = await run('strict', {}, [
      { field: 'files', filename: 'старый.xls', contentType: 'application/vnd.ms-excel', content: ole2 },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected[0]).toMatchObject({ reason: 'unsupported_type' });
  });

  it('HEIC отклоняется на входе со своей причиной', async () => {
    // Айфон по умолчанию снимает в HEIC. Конвейер такой файл принимал, но
    // распознать не мог никогда: vision работает с jpeg/png/webp/pdf, а по
    // расширению файл уходил в PDF-ветку и падал на pdftoppm. Отказ сразу, с
    // инструкцией, честнее тихого parse_failed через минуту.
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.alloc(60_000, 0x41),
    ]);
    const res = await run('strict', {}, [
      { field: 'files', filename: 'IMG_0042.HEIC', contentType: 'image/heic', content: heic },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected[0]).toMatchObject({ reason: 'heic_unsupported' });
    // Причина уходит наружу поставщику — она обязана быть в контракте.
    expect(PublicRejectReasonSchema.safeParse('heic_unsupported').success).toBe(true);
  });

  it('внутренний вход HEIC по-прежнему принимает', async () => {
    // Отказ ставится ТОЛЬКО публичной форме: почта и загрузка сотрудником
    // ведут себя как раньше, менять их поведение задачи не было.
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.alloc(60_000, 0x41),
    ]);
    const res = await run('legacy', {}, [
      { field: 'files', filename: 'IMG_0042.HEIC', contentType: 'image/heic', content: heic },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted).toHaveLength(1);
  });

  it('крошечная картинка отбраковывается как элемент подписи', async () => {
    const res = await run('strict', {}, [
      { field: 'files', filename: 'logo.jpg', contentType: 'image/jpeg', content: jpeg(2000) },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rejected[0]).toMatchObject({ reason: 'signature_image' });
  });

  it('годные файлы принимаются вместе с отбракованными', async () => {
    const res = await run('strict', {}, [
      { field: 'files', filename: 'good.pdf', contentType: 'application/pdf', content: pdf('good') },
      { field: 'files', filename: 'bad.txt', contentType: 'text/plain', content: Buffer.from('hello world') },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted.map((f) => f.filename)).toEqual(['good.pdf']);
    expect(res.rejected.map((f) => f.filename)).toEqual(['bad.txt']);
  });
});

describe('collectUploadParts — режим legacy (внутренний вход)', () => {
  it('неподдерживаемый тип отбрасывается молча, без rejected', async () => {
    const res = await run('legacy', {}, [
      { field: 'files', filename: 'note.txt', contentType: 'text/plain', content: Buffer.from('x') },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected).toHaveLength(0);
  });

  it('пустой файл не считается файлом', async () => {
    const res = await run('legacy', {}, [
      { field: 'files', filename: 'empty.pdf', contentType: 'application/pdf', content: Buffer.alloc(0) },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted).toHaveLength(0);
  });

  it('.xls по-прежнему принимается', async () => {
    const res = await run('legacy', {}, [
      {
        field: 'files',
        filename: 'старый.xls',
        contentType: 'application/vnd.ms-excel',
        content: Buffer.from('anything'),
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted).toHaveLength(1);
  });

  it('тип определяется по расширению, даже если mime не тот', async () => {
    const res = await run('legacy', {}, [
      {
        field: 'files',
        filename: 'скан.pdf',
        contentType: 'application/octet-stream',
        content: pdf('scan'),
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted).toHaveLength(1);
  });
});

describe('публичная загрузка — глобальный лимитер пропускает обычный запрос', () => {
  /**
   * Стенд с НАСТОЯЩИМ @fastify/rate-limit — в этом весь смысл набора.
   *
   * Заглушка лимитера здесь бесполезна: проверяется именно трактовка ответа
   * библиотеки. Её контракт неочевиден — `isAllowed: true` означает «ключ в
   * allowList», а не «запрос пропущен», и проверка по `!isAllowed` полгода
   * отдавала 429 на КАЖДУЮ отправку поставщика.
   *
   * Postgres и S3 не нужны: глобальная проверка стоит первой, а отказ
   * `no_files` формируется до обращения к таблице sites.
   */
  async function publicApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    // Без zod-компиляторов app.ready() падает: у роутов объявлены схемы ответа.
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    await instance.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 10 } });
    // Без redis — in-memory store: счётчик живёт внутри одного теста.
    await instance.register(rateLimit, { global: false });
    instance.decorate('db', {} as never);
    instance.decorate('queues', {} as never);
    await instance.register(publicUploadRoutes);
    await instance.ready();
    return instance;
  }

  function postEmpty(instance: FastifyInstance, ip = '10.55.0.7') {
    const { body, headers } = multipartBody(
      { siteId: randomUUID(), expectedDate: '2026-08-06', website: '' },
      [],
    );
    return instance.inject({
      method: 'POST',
      url: '/api/v1/public/upload-documents',
      payload: body,
      headers: { ...headers, 'x-real-ip': ip },
    });
  }

  it('первый запрос доходит до разбора формы, а не до 429', async () => {
    app = await publicApp();
    const res = await postEmpty(app);
    // Утверждение намеренно точное: not.toBe(429) осталось бы зелёным и при
    // 404, и при 500, и при сломанном multipart.
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no_files');
  });

  it('per-IP потолок срабатывает на 21-м запросе, а не раньше', async () => {
    // Заодно проверяет, что глобальный лимитер (200/час) не путается с
    // per-IP (20 за 10 минут): раньше отличить их было невозможно — 429
    // приходил всегда и от первого же запроса.
    app = await publicApp();
    const codes: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      codes.push((await postEmpty(app)).statusCode);
    }
    expect(codes.slice(0, 20)).toEqual(Array(20).fill(400));
    expect(codes[20]).toBe(429);
  });
});
