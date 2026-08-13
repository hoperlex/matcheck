import { Button, List, Upload, message } from 'antd';
import { FileTextOutlined, InboxOutlined } from '@ant-design/icons';
import type { UploadFile, UploadProps } from 'antd';
import { addFileBatch, rejectionMessage, type FileLimits, type FileRow } from './fileBatch';

export type { FileRow, FileLimits } from './fileBatch';

/**
 * Дропзона + список выбранных файлов.
 *
 * Общая для внутренней модалки «Загрузить документы» и публичной страницы
 * поставщика: сами по себе они разные (разные поля, разные лимиты, разный
 * транспорт), но выбор файлов у них одинаковый.
 */
export function FileDropList({
  rows,
  onChange,
  disabled,
  accept,
  hint,
  title = 'Перетащите документы поставки либо нажмите для выбора',
  otherZone = [],
  limits,
  compact = false,
}: {
  rows: FileRow[];
  onChange: (next: FileRow[]) => void;
  disabled?: boolean;
  accept: string;
  hint: string;
  /** Текст в дропзоне: зон в форме две, и они должны различаться на глаз. */
  title?: string;
  /**
   * Иконка и текст в строку вместо столбика. Нужно там, где зон в одной форме
   * две: вертикальный дефолт antd — под 180px на каждую, и поля уезжают за
   * пределы экрана. Внутренняя модалка «Загрузить документы» им не пользуется и
   * остаётся с прежним видом.
   */
  compact?: boolean;
  /**
   * Файлы соседней зоны формы. Один и тот же файл не должен попасть в обе
   * сразу: сервер такой запрос переживёт (сведёт к «только сохранить»), но
   * человеку честнее сказать сразу.
   */
  otherZone?: readonly FileRow[];
  /** Клиентские лимиты; считаются по обеим зонам вместе (см. fileBatch). */
  limits?: FileLimits;
}) {
  const uploadProps: UploadProps = {
    accept,
    multiple: true,
    showUploadList: false,
    // antd зовёт beforeUpload синхронно на КАЖДЫЙ файл пачки, а `rows` в этом
    // замыкании — состояние на момент рендера, между вызовами оно не меняется.
    // Поэтому пачку обрабатываем целиком на первом её файле, а остальные
    // вызовы пропускаем: иначе в списке оставался бы только последний файл, а
    // предупреждений было бы столько же, сколько файлов.
    beforeUpload: (file, fileList) => {
      const batch = fileList?.length ? fileList : [file];
      if (batch[0] !== file) return false;

      const { next, rejected } = addFileBatch({
        prev: rows,
        otherZone,
        files: batch as unknown as File[],
        limits,
      });

      const warning = rejectionMessage(rejected);
      if (warning) message.warning(warning);
      if (next.length !== rows.length) onChange(next);

      // false — файлы остаются у нас, antd сам никуда их не отправляет.
      return false;
    },
    fileList: [] as UploadFile[],
  };

  return (
    <>
      <Upload.Dragger {...uploadProps} disabled={disabled}>
        {compact ? (
          // Классы antd оставлены намеренно: из них приходят цвета (иконка —
          // colorPrimary, hint — вторичный текст). Инлайновые размеры и отступы
          // перебивают их по специфичности.
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              textAlign: 'left',
            }}
          >
            <p className="ant-upload-drag-icon" style={{ margin: 0, lineHeight: 1 }}>
              <InboxOutlined style={{ fontSize: 24 }} />
            </p>
            <div>
              <p className="ant-upload-text" style={{ fontSize: 14, marginBottom: 0 }}>
                {title}
              </p>
              <p className="ant-upload-hint" style={{ fontSize: 12, margin: 0 }}>
                {hint}
              </p>
            </div>
          </div>
        ) : (
          <>
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">{title}</p>
            <p className="ant-upload-hint">{hint}</p>
          </>
        )}
      </Upload.Dragger>

      {rows.length > 0 && (
        <List
          size="small"
          bordered
          style={{ marginTop: 12 }}
          dataSource={rows}
          renderItem={(r) => (
            <List.Item
              actions={[
                !disabled ? (
                  <Button
                    type="link"
                    size="small"
                    key="remove"
                    onClick={() => onChange(rows.filter((x) => x.uid !== r.uid))}
                  >
                    Убрать
                  </Button>
                ) : null,
              ]}
            >
              <List.Item.Meta
                avatar={<FileTextOutlined style={{ fontSize: 20 }} />}
                title={r.file.name}
                description={formatSize(r.file.size)}
              />
            </List.Item>
          )}
        />
      )}
    </>
  );
}

export function pluralFiles(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'файлов';
  if (last === 1) return 'файл';
  if (last >= 2 && last <= 4) return 'файла';
  return 'файлов';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}
