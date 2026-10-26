/**
 * XML из zip-архива СБИС: ровно один документ, пределы до и во время распаковки.
 * Архивы собираются здесь же — без библиотек, тем же форматом, что читает код.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractSingleXml, ZipRejected, ZIP_MAX_ENTRIES } from '../src/domain/edo/zip-single-xml.js';

type File = { name: string; data: Buffer; deflate?: boolean; declaredSize?: number; encrypted?: boolean };

/** Минимальный zip: локальные заголовки, каталог, конец каталога. CRC не проверяется кодом — нули. */
function zip(files: File[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.encrypted ? 1 : 0, 6);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.declaredSize ?? f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(f.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.declaredSize ?? f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const XML = Buffer.from('<?xml version="1.0"?><Файл ИдФайл="X"/>', 'utf8');

describe('XML из zip-архива СБИС', () => {
  it('один XML — сжатый и несжатый', () => {
    expect(extractSingleXml(zip([{ name: 'ON_X.xml', data: XML, deflate: true }]), 1024).bytes.equals(XML)).toBe(true);
    expect(extractSingleXml(zip([{ name: 'ON_X.xml', data: XML }]), 1024).bytes.equals(XML)).toBe(true);
  });

  it('description.xml и подписи — служебные, документ находится', () => {
    const got = extractSingleXml(
      zip([
        { name: 'description.xml', data: Buffer.from('<d/>') },
        { name: 'ON_X.xml', data: XML, deflate: true },
        { name: 'ON_X.xml.sgn', data: Buffer.from('sig') },
      ]),
      1024,
    );
    expect(got.name).toBe('ON_X.xml');
  });

  it('нет XML или их два — отказ, без догадок', () => {
    expect(() => extractSingleXml(zip([{ name: 'page1.png', data: Buffer.from('x') }]), 1024)).toThrow(ZipRejected);
    expect(() =>
      extractSingleXml(zip([{ name: 'a.xml', data: XML }, { name: 'b.xml', data: XML }]), 1024),
    ).toThrow(/2 XML/);
  });

  it('zip-бомба: распакованное больше предела — отказ во время распаковки', () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
    // Заголовок врёт о размере — предел всё равно срабатывает при распаковке.
    const bomb = zip([{ name: 'ON_X.xml', data: big, deflate: true, declaredSize: 10 }]);
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => extractSingleXml(bomb, 64 * 1024)).toThrow(ZipRejected);
  });

  it('объявленный размер больше предела — отказ до распаковки', () => {
    expect(() => extractSingleXml(zip([{ name: 'ON_X.xml', data: XML, declaredSize: 10_000_000 }]), 1024)).toThrow(
      /больше/,
    );
  });

  it('слишком много записей, шифрование, не zip — отказ', () => {
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({ name: `p${i}.png`, data: Buffer.from('x') }));
    expect(() => extractSingleXml(zip(many), 1024)).toThrow(/записей/);
    expect(() => extractSingleXml(zip([{ name: 'ON_X.xml', data: XML, encrypted: true }]), 1024)).toThrow(/зашифрован/);
    expect(() => extractSingleXml(XML, 1024)).toThrow(/конец каталога/);
  });
});
