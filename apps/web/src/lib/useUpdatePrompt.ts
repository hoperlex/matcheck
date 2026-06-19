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
const UPDATE_POLL_MS = 60 * 60 * 1000;

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
      // Час — компромисс: реже значит «деплой час невидим», чаще —
      // лишний трафик.
      setInterval(() => {
        void registration.update();
      }, UPDATE_POLL_MS);
    },
  });

  return {
    needRefresh,
    applyUpdate: () => {
      // updateServiceWorker(true) посылает SKIP_WAITING и затем
      // плагин сам делает window.location.reload() при controllerchange.
      // Не делаем reload вручную сверху — это привело бы к двойному.
      void updateServiceWorker(true);
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
