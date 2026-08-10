import { Tabs, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { PageId } from '@matcheck/contracts';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { api } from '../../services/api';

const DEFAULT_TAB = '/references/sites';

interface CountResp {
  total: number;
}

/**
 * Описание вкладок-подсправочников: путь-роут (он же ключ Tabs) +
 * подпись + URL для лёгкого count-запроса (limit=1, берём total из ответа).
 * Все эндпоинты возвращают `{ items, total }`, поэтому формат единый.
 */
// Порядок вкладок: Объекты · Контрагенты · Поставщики · МОЛ.
// «Контрагенты» и «Поставщики» — справочники заказчика (отдельные таблицы
// customer_counterparties / suppliers), НЕ операционная counterparties.
// «МОЛ» — read-only список из внешней БД ФОТ. Старые справочники
// «Ответственные лица»/«Материалы» и операционный «Контрагенты (legacy)»
// убраны из навигации — роуты сохранены в router.tsx, но в UI скрыты.
export const TAB_DEFS: { key: string; label: string; countUrl: string; page: PageId }[] = [
  { key: DEFAULT_TAB, label: 'Объекты', countUrl: '/sites?limit=1', page: 'references.sites' },
  {
    key: '/references/counterparties',
    label: 'Контрагенты',
    countUrl: '/customer-counterparties?limit=1',
    page: 'references.customer_counterparties',
  },
  {
    key: '/references/suppliers',
    label: 'Поставщики',
    countUrl: '/suppliers?limit=1',
    page: 'references.suppliers',
  },
  { key: '/references/mol', label: 'МОЛ', countUrl: '/mol', page: 'references.mol' },
  {
    key: '/references/units',
    label: 'Ед-ы изм.',
    countUrl: '/units?limit=1',
    page: 'references.units',
  },
];

export default function ReferencesLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { canView } = usePermissions();

  // Закрытая вкладка не должна ни рисоваться, ни считаться: count-запрос по
  // ней всё равно вернул бы 403, а человек увидел бы вкладку, ведущую в отказ.
  const visibleTabs = TAB_DEFS.filter((t) => canView(t.page));

  const active = visibleTabs.find((t) => location.pathname.startsWith(t.key))?.key ?? DEFAULT_TAB;

  // Параллельно тянем total по всем вкладкам. Запросы лёгкие
  // (limit=1), кэшируются react-query и переживают переключение вкладок.
  // null в data — счётчик пока не пришёл, PageTabs покажет подпись без скобок.
  const counts = useQuery({
    queryKey: ['references-counts', visibleTabs.map((t) => t.key).join(',')],
    queryFn: async (): Promise<Record<string, number>> => {
      const entries = await Promise.all(
        visibleTabs.map(async (t) => {
          try {
            const r = await api.get<CountResp>(t.countUrl);
            return [t.key, r.total] as const;
          } catch {
            return [t.key, -1] as const;
          }
        }),
      );
      const out: Record<string, number> = {};
      for (const [k, v] of entries) if (v >= 0) out[k] = v;
      return out;
    },
  });

  const items = visibleTabs.map((t) => {
    const c = counts.data?.[t.key];
    return {
      key: t.key,
      label: c == null ? t.label : `${t.label} (${c})`,
    };
  });

  return (
    <StickyPageHeader
      header={
        <>
          <Typography.Title level={3} style={{ margin: '0 0 8px' }}>
            Справочники
          </Typography.Title>
          <Tabs activeKey={active} items={items} onChange={(key) => navigate(key)} />
        </>
      }
    >
      <Outlet />
    </StickyPageHeader>
  );
}
