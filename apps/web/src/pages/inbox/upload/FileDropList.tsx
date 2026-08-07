import { Button, List, Upload } from 'antd';
import { FileTextOutlined, InboxOutlined } from '@ant-design/icons';
import type { UploadFile, UploadProps } from 'antd';

export type FileRow = { uid: string; file: File };

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
  canAdd,
}: {
  rows: FileRow[];
  onChange: (next: FileRow[]) => void;
  disabled?: boolean;
  accept: string;
  hint: string;
  /** Текст в дропзоне: зон в форме две, и они должны различаться на глаз. */
  title?: string;
  /**
   * Разрешено ли добавить файл. Нужно, чтобы один и тот же файл не попал в обе
   * зоны сразу: сервер такой запрос переживёт (сведёт к «только сохранить»), но
   * человеку честнее сказать сразу.
   */
  canAdd?: (file: File) => boolean;
}) {
  const uploadProps: UploadProps = {
    accept,
    multiple: true,
    showUploadList: false,
    beforeUpload: (file) => {
      const fileLike = file as unknown as File;
      if (canAdd && !canAdd(fileLike)) return false;
      onChange([
        ...rows,
        {
          uid: `${fileLike.name}-${fileLike.size}-${Date.now()}-${Math.random()}`,
          file: fileLike,
        },
      ]);
      // false — файл остаётся у нас, antd сам никуда его не отправляет.
      return false;
    },
    fileList: [] as UploadFile[],
  };

  return (
    <>
      <Upload.Dragger {...uploadProps} disabled={disabled}>
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">{title}</p>
        <p className="ant-upload-hint">{hint}</p>
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
