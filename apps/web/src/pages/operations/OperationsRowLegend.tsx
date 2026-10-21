import { Space, Typography } from 'antd';

const SWATCH_STYLE = {
  display: 'inline-block',
  width: 12,
  height: 12,
  borderRadius: 3,
} as const;
const LABEL_STYLE = { fontSize: 13, color: '#52525b' } as const;

/**
 * Легенда цветов подсветки строк в Принятых (Приёмка/Отгрузка).
 * Жёлтая строка — «Сегодня в процессе» (statusCode filled/shipped без МОЛ,
 * дата = сегодня по МСК). Красная — «Просрочено» (то же самое, но дата ранее
 * сегодня). Без подсветки — приёмка/отгрузка завершена либо ещё не начата.
 *
 * Используется как `pagination.showTotal` в ResponsiveTable, чтобы попасть
 * на одну линию с номерами страниц слева. Подбирали цвета в одну палитру
 * с CSS-правилами в OperationsPage.tsx — менять только согласованно.
 *
 * Подпись — как строка под таблицей в FOT (13px, приглушённая); квадратики
 * скруглены в тон рамке таблицы. Цвета заливки и рамки — прежние.
 */
export function OperationsRowLegend(): JSX.Element {
  return (
    <Space size={12} style={LABEL_STYLE}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{ ...SWATCH_STYLE, background: '#fffbe6', border: '1px solid #ffe58f' }}
        />
        <Typography.Text style={LABEL_STYLE}>Сегодня в процессе</Typography.Text>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{ ...SWATCH_STYLE, background: '#fff1f0', border: '1px solid #ffa39e' }}
        />
        <Typography.Text style={LABEL_STYLE}>Просрочено</Typography.Text>
      </span>
    </Space>
  );
}
