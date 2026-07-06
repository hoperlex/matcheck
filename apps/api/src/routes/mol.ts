import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { asZod } from '../lib/fastify.js';
import { MolListResponseSchema, type MolPerson } from '@matcheck/contracts';
import type { Db } from '../db/client.js';
import { getFotPool } from '../db/fot-client.js';
import { syncFotMolToLocalSerialized } from '../domain/mol/syncFotMol.js';

// Список МОЛ меняется редко (найм/увольнение) — кэшируем, чтобы не дёргать
// ФОТ-БД на каждый запрос. TTL 10 мин (середина диапазона 5–15 из ТЗ).
const CACHE_TTL_MS = 10 * 60 * 1000;

type Cache = { items: MolPerson[]; fetchedAt: string };
let cache: Cache | null = null;
let cacheAt = 0;
// Дедуп одновременных запросов при холодном кэше — один поход в ФОТ на всех.
let inflight: Promise<MolPerson[]> | null = null;

type FotRow = {
  employee_id: string | number;
  full_name: string;
  tab_number: string | null;
  position_name: string;
};

async function fetchFromFot(): Promise<MolPerson[]> {
  const pool = getFotPool();
  if (!pool) throw new Error('FOT_DATABASE_URL не сконфигурирован');
  // bigint (employee_id) postgres-js отдаёт строкой — приводим к number
  // (значения малы, в пределах safe integer).
  const rows = await pool<FotRow[]>`
    SELECT employee_id, full_name, tab_number, position_name
    FROM public.mol_persons
    ORDER BY full_name
  `;
  return rows.map((r) => ({
    employeeId: Number(r.employee_id),
    fullName: r.full_name,
    tabNumber: r.tab_number,
    positionName: r.position_name,
  }));
}

/**
 * Прогрев кэша + первичный sync ФОТ → локальная responsible_persons.
 * Вызывается из server.ts на старте, чтобы выпадающие списки МОЛ во
 * всех формах сразу показывали актуальный набор, не дожидаясь первого
 * запроса в /mol от UI. Молча игнорирует ошибку — при недоступной ФОТ
 * UI получит stale-кэш на следующем GET /mol.
 */
export async function warmUpFotMolCache(db: Db, log: FastifyBaseLogger): Promise<void> {
  try {
    if (inflight) {
      await inflight;
    } else {
      inflight = fetchFromFot().finally(() => {
        inflight = null;
      });
      const items = await inflight;
      cache = { items, fetchedAt: new Date().toISOString() };
      cacheAt = Date.now();
      await syncFotMolToLocalSerialized(db, items, log);
    }
  } catch (err) {
    log.warn({ err }, 'warmUpFotMolCache failed (FOT недоступна?)');
  }
}

export async function molRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/mol',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp', 'monitor')],
      schema: { response: { 200: MolListResponseSchema } },
    },
    async (req) => {
      // Свежий кэш — отдаём сразу.
      if (cache && Date.now() - cacheAt < CACHE_TTL_MS) {
        return { items: cache.items, total: cache.items.length, stale: false, fetchedAt: cache.fetchedAt };
      }
      try {
        if (!inflight) {
          inflight = fetchFromFot().finally(() => {
            inflight = null;
          });
        }
        const items = await inflight;
        cache = { items, fetchedAt: new Date().toISOString() };
        cacheAt = Date.now();
        // Зеркалим свежий список в локальную таблицу responsible_persons
        // (поле fot_employee_id), чтобы выпадающие МОЛ во всех формах
        // (Документ/Поставка/УПД/Накладная) показывали тот же набор, что
        // и Справочники → МОЛ. Не блокирует ответ — sync серилизован
        // через inflight в syncFotMol.ts.
        void syncFotMolToLocalSerialized(req.server.db, items, req.log);
        return { items, total: items.length, stale: false, fetchedAt: cache.fetchedAt };
      } catch (err) {
        // ФОТ недоступна — не падаем. Есть кэш — отдаём его с флагом stale;
        // нет — пустой список со stale=true (UI покажет «не удалось обновить»).
        req.log.error({ err }, 'FOT mol fetch failed');
        if (cache) {
          return { items: cache.items, total: cache.items.length, stale: true, fetchedAt: cache.fetchedAt };
        }
        return { items: [], total: 0, stale: true, fetchedAt: null };
      }
    },
  );
}
