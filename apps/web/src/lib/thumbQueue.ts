// Глобальные очереди параллельных запросов на загрузку фото через API-прокси
// /photos/:id/content.
//
// Зачем: после перевода галереи на API-прокси каждый thumb/оригинал — это
// полноценный HTTP-запрос с blob-телом. При открытии галереи с 10–20 фото
// react-query пытается запустить их все одновременно, а HTTP/2 multiplexing
// у Cloud.ru НЕ отменяет нагрузку на API: каждое соединение держит Node-stream
// и file descriptor. На 20+ одновременных пользователях это превращает
// endpoint /photos/:id/content в узкое место.
//
// Лимит общий на весь web-клиент: если пользователь быстро откроет вторую
// модалку, новые запросы встанут в очередь за уже идущими.

/** Создаёт независимый лимитер параллелизма: `enqueue(fn)` ждёт слот, запускает fn(), освобождает слот в finally. */
export function createLoadQueue(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    running--;
    const next = queue.shift();
    if (next) next();
  }

  return async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (running < limit) {
      running++;
    } else {
      await new Promise<void>((resolve) => {
        queue.push(() => {
          running++;
          resolve();
        });
      });
    }
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

// Миниатюры (~30–100 КБ). Лимит 4: сетка из 5–8 фото рисуется быстро, но одна
// галерея не забивает весь API-pool.
export const enqueueThumbLoad = createLoadQueue(4);

// Оригиналы (1–5 МБ) — отдельная очередь с меньшим лимитом. При открытии
// preview общий previewOpen-флаг включает fullQuery СРАЗУ у всех фото группы
// (иначе antd-PreviewGroup листает на растянутые миниатюры). Без лимита это
// шквал тяжёлых стримов к API/S3 — особенно заметный после включения HTTP/2,
// снявшего браузерный лимит 6 соединений. Отдельная очередь (не общая с thumb),
// чтобы превью оригинала не конкурировало за слоты с прорисовкой сетки миниатюр.
export const enqueueFullLoad = createLoadQueue(3);
