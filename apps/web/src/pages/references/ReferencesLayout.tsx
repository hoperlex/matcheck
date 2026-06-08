import { Tabs, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
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
// Вкладка «МОЛ» — список из внешней БД ФОТ (read-only), справа от Контрагентов.
// Старый внутренний справочник «Ответственные лица» (/references/responsible-persons)
// и «Материалы» убраны из навигации — роуты сохранены в router.tsx, но в
// основном UI скрыты. countUrl '/mol' отдаёт { total } так же, как остальные.
const TAB_DEFS: { key: string; label: string; countUrl: string }[] = [
  { key: DEFAULT_TAB, label: 'Объекты', countUrl: '/sites?limit=1' },
  { key: '/references/counterparties', label: 'Контрагенты', countUrl: '/counterparties?limit=1' },
  { key: '/references/mol', label: 'МОЛ', countUrl: '/mol' },
];

export default function ReferencesLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  const active = TAB_DEFS.find((t) => location.pathname.startsWith(t.key))?.key ?? DEFAULT_TAB;

  // Параллельно тянем total по всем 5 справочникам. Запросы лёгкие
  // (limit=1), кэшируются react-query и переживают переключение вкладок.
  // null в data — счётчик пока не пришёл, PageTabs покажет подпись без скобок.
  const counts = useQuery({
    queryKey: ['references-counts'],
    queryFn: async (): Promise<Record<string, number>> => {
      const entries = await Promise.all(
        TAB_DEFS.map(async (t) => {
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

  const items = TAB_DEFS.map((t) => {
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
