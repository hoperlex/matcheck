// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_FILES, filesProblem } from './uploadLimits';

/**
 * Обе зоны формы уезжают одним запросом, и сервер считает лимиты по нему
 * целиком. Если проверять зоны по отдельности, форма пропустит набор, который
 * сервер отвергнет с 413 уже после долгой заливки.
 */
const file = (name: string, size = 1024) => ({ name, size });

describe('лимиты поставки на публичной странице', () => {
  it('пустой набор отправить нельзя', () => {
    expect(filesProblem([])).toBe('Приложите хотя бы один документ');
  });

  it('количество считается по обеим зонам сразу', () => {
    const zoneA = Array.from({ length: 6 }, (_, i) => file(`upd-${i}.pdf`));
    const zoneB = Array.from({ length: 5 }, (_, i) => file(`cert-${i}.pdf`));
    // По отдельности каждая зона в лимит укладывается.
    expect(filesProblem(zoneA)).toBeNull();
    expect(filesProblem(zoneB)).toBeNull();
    expect(filesProblem([...zoneA, ...zoneB])).toBe(
      `Не больше ${MAX_FILES} файлов в одной поставке`,
    );
  });

  it('суммарный объём тоже считается по обеим зонам', () => {
    const big = file('upd.pdf', 9 * 1024 * 1024);
    const alsoBig = file('cert.pdf', 9 * 1024 * 1024);
    const third = file('spec.pdf', 5 * 1024 * 1024);
    expect(filesProblem([big, alsoBig])).toBeNull();
    expect(filesProblem([big, alsoBig, third])).toBe('Суммарный объём поставки больше 20 МБ');
  });

  it('слишком большой файл называется по имени', () => {
    expect(filesProblem([file('огромный.pdf', 11 * 1024 * 1024)])).toBe(
      'Файл «огромный.pdf» больше 10 МБ',
    );
  });
});
