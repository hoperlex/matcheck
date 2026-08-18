import { describe, expect, it } from 'vitest';
import { restoreTargetFor } from '../src/domain/jobs/recognition-recovery.js';

/**
 * Куда возвращается документ, у которого распознавание исчерпало попытки.
 *
 * Заглушка `recovery_exhausted` уместна там, где результата не было вовсе. Но в
 * `processing` попадает и работа ПОВЕРХ уже распознанного документа — ручной
 * повтор и второй проход vision. Превратить такой документ в заглушку значит
 * убрать его с планшета (инспектору видно только `parsed`) из-за неудачи
 * необязательного уточнения — при том, что номер, сумма и позиции у него есть.
 */
describe('состояние, в которое возвращает терминализация', () => {
  it('первичное распознавание возвращать некуда — будет заглушка', () => {
    expect(restoreTargetFor({ reparse: null, secondPass: null })).toBeNull();
  });

  it('незавершённый ручной повтор откатывается к своему снимку', () => {
    const target = restoreTargetFor({
      reparse: {
        state: 'processing',
        generation: 4,
        snapshot: {
          status: 'parsed',
          parseErrorCode: null,
          parseErrorDetails: null,
          validation: { ok: true },
          secondPass: null,
        },
      },
      secondPass: null,
    });

    expect(target?.origin).toBe('reparse_snapshot');
    // Документ возвращается ровно в тот вид, в котором инспектор его видел.
    expect(target?.values.status).toBe('parsed');
    expect(target?.values.parseErrorCode).toBeNull();
    expect(target?.values.validation).toEqual({ ok: true });
    expect(target?.values.reparse).toMatchObject({ state: 'failed' });
  });

  it('снимок отбирается по незавершённости, а не по равенству поколений', () => {
    // Каждая попытка recovery поднимает dispatch_generation, и снимок законно
    // отстаёт от него на число попыток. Сравнение поколений напрямую отсекло бы
    // именно те документы, ради которых снимок и делался.
    const target = restoreTargetFor({
      reparse: { state: 'queued', generation: 1, snapshot: { status: 'parsed' } },
      secondPass: null,
    });
    expect(target?.origin).toBe('reparse_snapshot');
  });

  it('завершённый повтор снимком уже не распоряжается', () => {
    // succeeded/failed означают, что результат применён: откатывать нечего, и
    // старый снимок вернул бы документ к позавчерашнему виду.
    for (const state of ['succeeded', 'failed']) {
      expect(
        restoreTargetFor({
          reparse: { state, generation: 3, snapshot: { status: 'parsed' } },
          secondPass: null,
        }),
      ).toBeNull();
    }
  });

  it('незавершённый второй проход возвращает результат ПЕРВОГО прохода', () => {
    const target = restoreTargetFor({
      reparse: null,
      secondPass: {
        state: 'queued',
        mode: 'vision',
        restore: { status: 'parsed', parseErrorCode: null, parseErrorDetails: null },
      },
    });

    expect(target?.origin).toBe('second_pass');
    expect(target?.values.status).toBe('parsed');
    expect(target?.values.secondPass).toMatchObject({ state: 'failed' });
  });

  it('второй проход без снимка возвращать некуда', () => {
    // Документы, поставленные в очередь до выката: поля restore у них нет.
    // Заглушка здесь честнее выдуманного статуса.
    expect(
      restoreTargetFor({ reparse: null, secondPass: { state: 'queued', mode: 'vision' } }),
    ).toBeNull();
  });

  it('ручной повтор старше второго прохода', () => {
    // Повтор обнуляет second_pass, поэтому одновременно они появиться не могут.
    // Но если данные уже разъехались, снимок повтора полнее: в нём есть и
    // validation, и прежнее состояние самого second_pass.
    const target = restoreTargetFor({
      reparse: { state: 'queued', generation: 2, snapshot: { status: 'needs_resolution' } },
      secondPass: { state: 'queued', restore: { status: 'parsed' } },
    });
    expect(target?.origin).toBe('reparse_snapshot');
  });
});
