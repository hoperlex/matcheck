// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { MAX_DELIVERIES, submitDeliveries, type QueuePatch } from './submitQueue';

/**
 * Правила очереди отправки поставок.
 *
 * Всё это легко сломать незаметной правкой компонента, а цена ошибки высокая:
 * поставщик либо отправит документы дважды, либо решит, что отправил, хотя
 * половина не дошла.
 */
type Item = { id: string; state: 'draft' | 'sending' | 'sent' | 'failed' };

function collector() {
  const patches: Array<{ id: string; patch: QueuePatch }> = [];
  return {
    patches,
    onUpdate: (id: string, patch: QueuePatch) => patches.push({ id, patch }),
    statesOf: (id: string) => patches.filter((p) => p.id === id).map((p) => p.patch.state),
  };
}

const ok = (ticket: string) => ({ ticket, filesRejected: [] });

describe('submitDeliveries', () => {
  it('отправляет поставки строго по очереди, а не параллельно', async () => {
    const order: string[] = [];
    let inFlight = 0;
    const c = collector();

    await submitDeliveries<Item>(
      [
        { id: 'a', state: 'draft' },
        { id: 'b', state: 'draft' },
        { id: 'c', state: 'draft' },
      ],
      {
        send: async (item) => {
          inFlight += 1;
          // Параллельного запуска быть не должно: сервер считает лимит по
          // адресу, а пользователю нужен предсказуемый порядок в списке.
          expect(inFlight).toBe(1);
          await new Promise((r) => setTimeout(r, 1));
          order.push(item.id);
          inFlight -= 1;
          return ok(`T-${item.id}`);
        },
        onUpdate: c.onUpdate,
      },
    );

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('каждая поставка проходит sending → sent и получает свой номер', async () => {
    const c = collector();
    const summary = await submitDeliveries<Item>([{ id: 'a', state: 'draft' }], {
      send: async () => ok('TICKET-1'),
      onUpdate: c.onUpdate,
    });

    expect(c.statesOf('a')).toEqual(['sending', 'sent']);
    expect(c.patches.at(-1)?.patch.ticket).toBe('TICKET-1');
    expect(summary).toEqual({ sent: 1, failed: 0 });
  });

  it('ошибка одной поставки не останавливает остальные', async () => {
    const c = collector();
    const summary = await submitDeliveries<Item>(
      [
        { id: 'a', state: 'draft' },
        { id: 'b', state: 'draft' },
        { id: 'c', state: 'draft' },
      ],
      {
        send: async (item) => {
          if (item.id === 'b') throw new Error('S3 недоступен');
          return ok(`T-${item.id}`);
        },
        onUpdate: c.onUpdate,
      },
    );

    expect(summary).toEqual({ sent: 2, failed: 1 });
    expect(c.statesOf('b')).toEqual(['sending', 'failed']);
    // Третья всё равно ушла — поставщику не надо начинать всё заново.
    expect(c.statesOf('c')).toEqual(['sending', 'sent']);
  });

  it('текст ошибки берётся из describeError и попадает в патч', async () => {
    const c = collector();
    await submitDeliveries<Item>([{ id: 'a', state: 'draft' }], {
      send: async () => {
        throw new Error('boom');
      },
      onUpdate: c.onUpdate,
      describeError: () => 'Слишком много загрузок',
    });

    expect(c.patches.at(-1)?.patch).toMatchObject({
      state: 'failed',
      error: 'Слишком много загрузок',
    });
  });

  it('повторный запуск шлёт только неудачные, принятые пропускает', async () => {
    const send = vi.fn(async (item: Item) => ok(`T-${item.id}`));
    const c = collector();

    await submitDeliveries<Item>(
      [
        { id: 'a', state: 'sent' },
        { id: 'b', state: 'failed' },
        { id: 'c', state: 'sent' },
      ],
      { send, onUpdate: c.onUpdate },
    );

    // Принятые повторно не отправляются — иначе документы задвоились бы.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].id).toBe('b');
    expect(c.patches.every((p) => p.id === 'b')).toBe(true);
  });

  it('пустая очередь не падает и ничего не отправляет', async () => {
    const send = vi.fn();
    const summary = await submitDeliveries<Item>([], { send, onUpdate: () => {} });
    expect(send).not.toHaveBeenCalled();
    expect(summary).toEqual({ sent: 0, failed: 0 });
  });

  it('потолок поставок за отправку — 10', () => {
    expect(MAX_DELIVERIES).toBe(10);
  });
});
