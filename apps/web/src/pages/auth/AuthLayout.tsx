import type { ReactNode } from 'react';
import { Grid, Typography } from 'antd';

const { useBreakpoint } = Grid;

/**
 * Двухколоночный макет для страниц входа/регистрации. Слева — минималистичная
 * брендовая панель: логотип «М» и надпись «Приёмка материалов». Справа — форма
 * (`children`) с заголовком/подзаголовком. На узких экранах левая панель
 * скрывается, остаётся одна колонка с компактным логотипом сверху.
 *
 * Только оболочка вокруг форм — никакой бизнес-логики. Формы (Login/Register)
 * передают свой контент как `children`; их обработчики и данные не меняются.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}): JSX.Element {
  const screens = useBreakpoint();
  const twoCol = Boolean(screens.lg);

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', background: '#fff' }}>
      {twoCol && (
        <div
          style={{
            flex: '1 1 50%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 20,
            padding: 48,
            background: 'linear-gradient(135deg, #eaf1ff 0%, #f6faff 55%, #ffffff 100%)',
          }}
        >
          <img src="/favicon.svg" alt="" width={72} height={72} style={{ borderRadius: 18 }} />
          <Typography.Title style={{ margin: 0, fontSize: 38, fontWeight: 700 }}>
            Приёмка материалов
          </Typography.Title>
        </div>
      )}

      <div
        style={{
          flex: twoCol ? '1 1 50%' : '1 1 100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#fff',
        }}
      >
        <div style={{ width: '100%', maxWidth: 400 }}>
          {!twoCol && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
              <img src="/favicon.svg" alt="" width={36} height={36} style={{ borderRadius: 9 }} />
              <Typography.Text strong style={{ fontSize: 17 }}>
                Приёмка материалов
              </Typography.Text>
            </div>
          )}
          <Typography.Title level={3} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 24 }}>
            {subtitle ?? ' '}
          </Typography.Paragraph>
          {children}
        </div>
      </div>
    </div>
  );
}
