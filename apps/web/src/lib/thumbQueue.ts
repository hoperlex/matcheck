// Глобальная очередь параллельных запросов на загрузку фото-миниатюр.
//
// Зачем: после перевода галереи на API-прокси /photos/:id/content каждый
// thumb это полноценный HTTP-запрос с blob-телом ~30–100 КБ. При открытии
// галереи с 10–20 фото react-query пытается запустить их все одновременно,
// а HTTP/2 multiplexing у Cloud.ru не отменяет нагрузку на API: каждое
// соединение держит Node-stream и file descriptor. На 20+ одновременных
// пользователях это превращает endpoint /photos/:id/content в узкое
// место (см. ревью фикса нагрузки от 2026-06-15).
//
// Лимит 4 параллельных — компромисс: достаточно, чтобы сетка из 5–8 фото
// рисовалась быстро, но не позволяет одной галерее «забить» весь API-pool.
// Лимит общий на весь web-клиент: если пользователь быстро откроет вторую
// модалку, новые thumb встанут в очередь за уже идущими.
//
// API минимальный: `enqueue(fn)` ждёт свободный слот, запускает fn(),
// возвращает её результат, обязательно освобождает слот в finally.

const LIMIT = 4;

let running = 0;
const queue: Array<() => void> = [];

function release(): void {
  running--;
  const next = queue.shift();
  if (next) next();
}

export async function enqueueThumbLoad<T>(fn: () => Promise<T>): Promise<T> {
  if (running < LIMIT) {
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
}
