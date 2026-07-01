import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * Управляемая регистрация service worker'а через vite-plugin-pwa.
 *
 * Возвращает:
 *  - needRefresh — есть waiting SW, нужно показать баннер обновления;
 *  - applyUpdate() — активирует новый SW (SKIP_WAITING) и делает reload
 *    страницы. Reload — последний шаг, поэтому возвращаемый Promise
 *    практически никогда не резолвится в текущем коде.
 *  - dismiss() — скрыть баннер до следующего обнаружения update.
 *
 * Поведение:
 *  - При load страницы плагин регистрирует SW. Если на сервере появилась
 *    новая версия — браузер скачивает её, активирует precache, новый SW
 *    встаёт в waiting. useRegisterSW вызывает onNeedRefresh → needRefresh
 *    = true.
 *  - В prompt-mode плагина новый SW НЕ забирает controll сам; ждёт нашего
 *    SKIP_WAITING.
 *  - applyUpdate(true) посылает SKIP_WAITING через workbox-window
 *    (internal в vite-plugin-pwa) → controllerchange → плагин делает
 *    window.location.reload() автоматически (см. doc plugin'а:
 *    `immediate` reload поддерживается из коробки).
 *  - Периодически (раз в час) дёргаем `r.update()` через registration,
 *    чтобы пользователь, не закрывая вкладку сутками, всё равно увидел
 *    баннер. Этот update-poll использует HTTP-кеш-headers (сравнение
 *    `sw.js` Last-Modified / ETag), стоимость — один HEAD-запрос в час.
 *
 * Без бесконечного reload-loop: после applyUpdate() браузер один раз
 * делает controllerchange и одну перезагрузку. Дополнительный SW в этой
 * сессии не появится до следующего deploy.
 */
// Раз в минуту: после деплоя открытая вкладка должна узнать о новой версии
// быстро (баннер «Обновить» появляется в течение ~минуты), а не через час.
// Стоимость — один лёгкий HEAD-запрос sw.js в минуту на вкладку.
const UPDATE_POLL_MS = 60 * 1000;

export function useUpdatePrompt(): {
  needRefresh: boolean;
  applyUpdate: () => void;
  dismiss: () => void;
} {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      // setInterval живёт всю жизнь вкладки — это нормально, SW
      // регистрируется один раз и не переинициализируется. Закрытие
      // вкладки убирает таймер вместе с window. Без cleanup, потому
      // что useRegisterSW.onRegisteredSW не поддерживает возврат
      // disposer'а (см. RegisterSWOptions).
      //
      // Без этого пользователь, не закрывающий вкладку, видит баннер
      // только при следующем спонтанном reload SW'а (после navigate).
      // Немедленная первая проверка + минутный интервал: свежий деплой
      // становится виден почти сразу, а не через час.
      void registration.update();
      setInterval(() => {
        void registration.update();
      }, UPDATE_POLL_MS);
    },
  });

  return {
    needRefresh,
    applyUpdate: () => {
      // updateServiceWorker(true) шлёт SKIP_WAITING. vite-plugin-pwa ДОЛЖЕН сам
      // перезагрузить страницу по событию `controlling`, НО только если
      // event.isUpdate === true. А isUpdate = Boolean(navigator.serviceWorker
      // .controller) на момент загрузки — и он часто false: первый визит,
      // режим инкогнито, и (иронично) сразу после Ctrl+Shift+R, который
      // отвязывает контроллер. Тогда плагин reload НЕ делает → баннер висит,
      // ничего не меняется. Поэтому перезагружаемся сами, надёжно:
      //   1) как только новый SW взял управление (controllerchange) → reload;
      //   2) fallback-таймер — на случай, если waiting-воркера нет или
      //      messageSkipWaiting оказался no-op (controllerchange не наступит).
      // Флаг `reloaded` гарантирует единственный reload (без циклов).
      let reloaded = false;
      const doReload = () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      };
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', doReload, { once: true });
      }
      void updateServiceWorker(true);
      // Подстраховка: если за 2.5с контроллер не сменился — всё равно
      // перезагружаемся, чтобы подтянуть новую версию портала.
      window.setTimeout(doReload, 2500);
    },
    dismiss: () => setNeedRefresh(false),
  };
}

/**
 * Опциональная хелпер-функция для разработки: проверяет, что
 * SW зарегистрирован вообще (на http://localhost тоже работает, если
 * devOptions.enabled=true). Не используется в UI, оставлен для отладки.
 */
export function isPwaRegistered(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return Promise.resolve(false);
  return navigator.serviceWorker.getRegistration().then((r) => !!r);
}
