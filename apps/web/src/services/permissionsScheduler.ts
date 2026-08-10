// Жизненный цикл прав во вкладке: когда грузить, когда обновлять, когда
// забыть. По образцу authScheduler.ts — подписка активируется при первом
// импорте модуля (импорт делает AuthProvider.tsx).
//
// Обновлений три, и ни одно не лишнее:
//
//   polling ~30 c   — админ снял право у работающего человека; без опроса он
//                     узнал бы об этом только при следующей перезагрузке;
//   focus/visible   — ЕДИНСТВЕННОЕ, что ловит ВОЗВРАТ права быстро: спрятанная
//                     кнопка сама запроса не сделает, а человек как раз
//                     возвращается во вкладку после «дай мне доступ»;
//   после 403       — сервер только что отказал; значит наши права устарели
//                     ровно сейчас (подписка на api.ts ниже).
//
// Все три идут через один single-flight в permissionsSync.ts, поэтому
// одновременное срабатывание даёт один сетевой запрос.

import { useAuthStore } from '../stores/auth';
import { usePermissionsStore } from '../stores/permissions';
import { syncPermissions } from './permissionsSync';
import { onForbidden } from './api';

const POLL_MS = 30_000;
// Отказ может прилететь пачкой (страница шлёт несколько запросов разом) —
// перезагружать права на каждый незачем.
const FORBIDDEN_COOLDOWN_MS = 5_000;

// Глобальный setInterval, а не window.setInterval: модуль импортируется и в
// node-окружении тестов, где window нет вовсе.
let timer: ReturnType<typeof setInterval> | null = null;
let lastForbiddenSync = 0;

function stopPolling(): void {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

function startPolling(): void {
  stopPolling();
  timer = setInterval(() => {
    // В свёрнутой вкладке опрашивать нечего: вернётся — сработает focus.
    if (typeof document !== 'undefined' && document.hidden) return;
    void syncPermissions(useAuthStore.getState().user);
  }, POLL_MS);
  // Опрос прав не должен держать процесс живым (актуально для SSR/тестов).
  (timer as { unref?: () => void }).unref?.();
}

function onFocus(): void {
  if (!useAuthStore.getState().user) return;
  void syncPermissions(useAuthStore.getState().user);
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) onFocus();
  });
}

// Сервер отказал по матрице — наши права заведомо устарели.
onForbidden(() => {
  const now = Date.now();
  if (now - lastForbiddenSync < FORBIDDEN_COOLDOWN_MS) return;
  lastForbiddenSync = now;
  void syncPermissions(useAuthStore.getState().user);
});

// Смена пользователя во вкладке. Выход ОБЯЗАН стирать права: иначе следующий
// вошедший первые секунды видел бы меню предыдущего.
let prevUserId: string | null = useAuthStore.getState().user?.id ?? null;
useAuthStore.subscribe((state) => {
  const nextUserId = state.user?.id ?? null;
  if (nextUserId === prevUserId) return;
  prevUserId = nextUserId;

  if (!nextUserId) {
    stopPolling();
    usePermissionsStore.getState().clear();
    return;
  }
  usePermissionsStore.getState().clear();
  void syncPermissions(state.user);
  startPolling();
});

// Модуль мог быть импортирован уже после восстановления сессии — тогда
// подписка выше не сработает, и права никто не загрузит.
if (prevUserId) {
  void syncPermissions(useAuthStore.getState().user);
  startPolling();
}
