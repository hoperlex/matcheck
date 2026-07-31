/**
 * Формат ключа диспетчеризации.
 *
 * Ключ уходит в BullMQ как custom job id, а тот строит из него ключи Redis и
 * отвергает двоеточие ошибкой «Custom Id cannot contain :». Дефект прошёл в
 * прод: задания молча не доставлялись, документы висели в `queued`, а
 * интеграционные тесты его не видели — в них BullMQ подменён заглушкой.
 *
 * Поэтому проверка идёт против НАСТОЯЩЕЙ библиотеки: берём её собственный
 * валидатор, а не повторяем правило своими словами.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Job } from 'bullmq';
import { bundleDispatchKeyOf, dispatchKeyOf } from '../src/domain/jobs/job-outbox.js';

/** Валидатор BullMQ: бросает, если id не годится в качестве custom job id. */
function assertBullmqAccepts(jobId: string): void {
  // Статический метод внутри Job — тот же, что вызывается при queue.add.
  const validate = (Job as unknown as { validateJobId?: (id: string) => void }).validateJobId;
  if (typeof validate === 'function') {
    validate(jobId);
    return;
  }
  // Библиотека сменила внутреннее имя — проверяем документированное правило.
  if (jobId.includes(':')) throw new Error('Custom Id cannot contain :');
}

describe('ключ диспетчеризации задания', () => {
  const docId = randomUUID();
  const bundleId = randomUUID();

  it('ключ документа принимается BullMQ', () => {
    expect(() => assertBullmqAccepts(dispatchKeyOf(docId))).not.toThrow();
  });

  it('ключ пакета принимается BullMQ', () => {
    expect(() => assertBullmqAccepts(bundleDispatchKeyOf(bundleId))).not.toThrow();
  });

  it('двоеточия в ключе нет — иначе задание не доставится', () => {
    expect(dispatchKeyOf(docId)).not.toContain(':');
    expect(bundleDispatchKeyOf(bundleId)).not.toContain(':');
  });

  it('ключ однозначно указывает на свою запись', () => {
    const other = randomUUID();
    expect(dispatchKeyOf(docId)).toContain(docId);
    expect(dispatchKeyOf(docId)).not.toBe(dispatchKeyOf(other));
    // Документ и пакет с одинаковым идентификатором не должны совпасть.
    expect(dispatchKeyOf(docId)).not.toBe(bundleDispatchKeyOf(docId));
  });

  it('поколение меняет ключ — намеренный перезапуск действительно запускается', () => {
    // BullMQ держит завершённые задания сутки: без смены ключа повторный
    // разбор молча не стартовал бы.
    expect(dispatchKeyOf(docId, 1)).not.toBe(dispatchKeyOf(docId, 0));
    expect(bundleDispatchKeyOf(bundleId, 2)).not.toBe(bundleDispatchKeyOf(bundleId, 0));
  });

  it('идентификатор с двоеточием отвергается на месте, а не в очереди', () => {
    // Защита от возврата дефекта: если кто-то подставит «грязный» id, ошибка
    // всплывёт при построении ключа, а не через 6 неудачных доставок.
    expect(() => dispatchKeyOf('a:b')).toThrow(/недопустимый ключ/);
  });
});
