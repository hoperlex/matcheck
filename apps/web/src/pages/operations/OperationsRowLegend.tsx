import { Space, Typography } from 'antd';

/**
 * Легенда цветов подсветки строк в Принятых (Приёмка/Отгрузка).
 * Жёлтая строка — «Сегодня в процессе» (statusCode filled/shipped без МОЛ,
 * дата = сегодня по МСК). Красная — «Просрочено» (то же самое, но дата ранее
 * сегодня). Без подсветки — приёмка/отгрузка завершена либо ещё не начата.
 *
 * Используется как `pagination.showTotal` в ResponsiveTable, чтобы попасть
 * на одну линию с номерами страниц слева. Подбирали цвета в одну палитру
 * с CSS-правилами в OperationsPage.tsx — менять только согласованно.
 */
export function OperationsRowLegend(): JSX.Element {
  return (
    <Space size={12} style={{ fontSize: 12, color: '#595959' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 12,
            height: 12,
            background: '#fffbe6',
            border: '1px solid #ffe58f',
            borderRadius: 2,
          }}
        />
        <Typography.Text style={{ fontSize: 12 }}>Сегодня в процессе</Typography.Text>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 12,
            height: 12,
            background: '#fff1f0',
            border: '1px solid #ffa39e',
            borderRadius: 2,
          }}
        />
        <Typography.Text style={{ fontSize: 12 }}>Просрочено</Typography.Text>
      </span>
    </Space>
  );
}
