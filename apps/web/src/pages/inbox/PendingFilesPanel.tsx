/**
 * Принятые файлы, по которым документа ещё нет.
 *
 * Зачем отдельный блок над списком. Между приёмом файла и появлением документа
 * лежит разбор: обычно секунды, при забитой очереди — часы. Всё это время в
 * «Документах» не было ничего, и менеджер не мог отличить «поставщик не
 * присылал» от «прислал, но мы ещё не разобрали». Единственным местом, где файл
 * был виден, оставалась вкладка «Без документов» — то есть уже разбор
 * инцидента, а не нормальная работа.
 *
 * Почему НЕ строками основной таблицы. Там у строки есть тип, статус разбора,
 * реквизиты, чекбокс массового удаления, раскрытие позиций и переход в
 * карточку. У принятого файла нет ничего из этого: он не документ. Подмешать
 * его в тот же dataSource значит завести полтора десятка мест, где придётся
 * помнить «а вдруг это не документ» — и каждое такое место однажды забудут.
 * Отдельная таблица говорит то же самое, ничем не рискуя.
 *
 * Метка машины — общая с документами: файл и уже разобранные документы той же
 * поставки получают одну цветную полосу, поэтому видно, что они приехали одним
 * рейсом.
 */
import { Alert, Table, Tag, Tooltip, Typography } from 'antd';
import type { PendingFile } from '@matcheck/contracts';
import { GROUP_COLORS, groupRowClass } from '../../shared/ui/documentGroupRows';

const { Text } = Typography;

/** Человеческое время приёма: «сегодня 14:07» короче полной даты и читается быстрее. */
function acceptedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay =
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `сегодня ${time}`;
  return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
}

export function PendingFilesPanel({ files }: { files: PendingFile[] }) {
  if (files.length === 0) return null;

  const notStored = files.filter((f) => f.state === 'not_stored');

  return (
    <div style={{ marginBottom: 12 }}>
      {/* Полосы машины — те же классы, что у основной таблицы: файл и
          документы одной поставки помечены одним цветом. */}
      <style>
        {GROUP_COLORS.map(
          (color, i) =>
            `.matcheck-doc-group-${i} > td:first-child { box-shadow: inset 4px 0 0 ${color}; }`,
        ).join('\n')}
      </style>

      {notStored.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          message={
            notStored.length === 1
              ? 'Один файл не сохранился в хранилище'
              : `Файлов не сохранилось: ${notStored.length}`
          }
          description={
            'Остальные файлы поставки приняты и разбираются. Попросите отправителя прислать ' +
            'только эти — повторная отправка дозагрузит недостающее, ничего не задваивая.'
          }
        />
      )}

      <Table<PendingFile>
        size="small"
        rowKey="key"
        dataSource={files}
        pagination={false}
        rowClassName={(f) => groupRowClass(f.portalGroupId)}
        title={() => (
          <Text type="secondary">
            Загружены, ожидают обработки — {files.length}
          </Text>
        )}
        columns={[
          {
            title: 'Файл',
            dataIndex: 'filename',
            render: (_: unknown, f: PendingFile) => (
              <Tooltip title={f.filename}>
                <Text ellipsis style={{ maxWidth: 420, display: 'inline-block' }}>
                  {f.filename}
                </Text>
              </Tooltip>
            ),
          },
          {
            title: 'Состояние',
            dataIndex: 'state',
            width: 260,
            render: (_: unknown, f: PendingFile) =>
              f.state === 'not_stored' ? (
                // Ссылки на такой файл нет намеренно: объекта в хранилище не
                // существует, и кнопка «открыть» вела бы в пустоту.
                <Tag color="red">не загружен — нужна повторная отправка</Tag>
              ) : (
                <Tag color="processing">в очереди на распознавание</Tag>
              ),
          },
          {
            title: 'Объект',
            dataIndex: 'siteName',
            width: 200,
            render: (v: string | null) => v ?? '—',
          },
          {
            title: 'Дата поставки',
            dataIndex: 'expectedDate',
            width: 140,
            render: (v: string | null) =>
              v ? new Date(v).toLocaleDateString('ru-RU') : '—',
          },
          {
            title: 'Принят',
            dataIndex: 'createdAt',
            width: 140,
            render: (v: string) => acceptedAt(v),
          },
        ]}
      />
    </div>
  );
}
