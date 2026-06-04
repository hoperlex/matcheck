import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Кеш считается свежим 60s — возврат в раздел в этом окне
            // показывает данные мгновенно без сетевого запроса. До этого
            // было 30s; 60s — хороший компромисс между «свежесть» и
            // «мгновенный UX». invalidateQueries в мутациях продолжает
            // работать как раньше — пользователь видит актуальные данные
            // сразу после Save / Delete / т.п.
            staleTime: 60_000,
            // gcTime по умолчанию 5 минут (react-query v5) — оставляем.
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
