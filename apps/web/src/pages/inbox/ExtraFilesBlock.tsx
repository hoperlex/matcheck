import { useState } from 'react';
import { Button, Dropdown, List, Typography, message } from 'antd';
import { DownloadOutlined, FileTextOutlined } from '@ant-design/icons';
import type { ExtraFile } from '@matcheck/contracts';
import {
  apiDownloadExtraFile,
  apiGetBundleExtraFileUrl,
  saveBlobAsFile,
} from '../../services/api';
import { formatSize } from './upload/FileDropList';

/**
 * Дополнительные документы поставки: файлы, сохранённые без распознавания —
 * сертификаты, паспорта качества и прочие приложения.
 *
 * Два места показа, и ведут они себя по-разному:
 *
 *  - карточка документа — кнопка в футере рядом с «Сохранить»
 *    (`ExtraFilesFooterButton`). Там только СКАЧИВАНИЕ: файл идёт потоком через
 *    API с `Content-Disposition: attachment`, вкладки с просмотром не
 *    открываются и presigned-ссылка на S3 в браузер не попадает;
 *  - раздел «Комплекты без документов» — список с «Открыть» (`ExtraFilesBlock`).
 *    Карточки у комплекта нет, поэтому и маршрут другой: права там не
 *    наследуются от документа.
 *
 * Ссылка запрашивается по клику, а не заранее: presign живёт час, а список
 * может провисеть в открытом окне дольше.
 */
export function ExtraFilesBlock({ files }: { files: ExtraFile[] }) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function open(f: ExtraFile) {
    setBusyId(f.id);
    try {
      const link = await apiGetBundleExtraFileUrl(f.bundleId, f.id);
      window.open(link.url, '_blank', 'noopener');
    } catch {
      message.error(`Не удалось открыть файл «${f.filename}»`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <List
      size="small"
      dataSource={files}
      renderItem={(f) => (
        <List.Item
          actions={[
            <Button key="open" type="link" size="small" loading={busyId === f.id} onClick={() => open(f)}>
              Открыть
            </Button>,
          ]}
        >
          <List.Item.Meta
            avatar={<FileTextOutlined style={{ fontSize: 18 }} />}
            title={f.filename}
            description={describeExtraFile(f)}
          />
        </List.Item>
      )}
    />
  );
}

/**
 * Кнопка доп. документов в футере карточки документа.
 *
 * Один файл — кнопка качает его сразу. Несколько — выпадающий список, где
 * каждый клик скачивает свой файл. Пункта «скачать все» нет намеренно: после
 * первого `await` пользовательская активация потеряна и браузер вправе
 * заблокировать остальные автозагрузки, а клик по строке — самостоятельный
 * жест, который блокировать не за что.
 */
export function ExtraFilesFooterButton({
  files,
  documentId,
}: {
  files: ExtraFile[];
  documentId: string;
}) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function download(f: ExtraFile) {
    // Без этого второй клик по списку затёр бы downloadingId, и первый же
    // ответивший запрос снял бы индикатор с ещё качающегося файла.
    if (downloadingId) return;
    setDownloadingId(f.id);
    try {
      const { blob, filename } = await apiDownloadExtraFile(documentId, f.id);
      saveBlobAsFile(blob, filename || f.filename);
    } catch {
      message.error(`Не удалось скачать файл «${f.filename}»`);
    } finally {
      setDownloadingId(null);
    }
  }

  const label = `Доп. документы (${files.length})`;
  const first = files[0];
  if (files.length === 1 && first) {
    return (
      <Button
        icon={<DownloadOutlined />}
        loading={downloadingId !== null}
        onClick={() => void download(first)}
      >
        {label}
      </Button>
    );
  }

  return (
    <Dropdown
      open={open}
      // Выбор пункта список не закрывает — сертификаты обычно качают пачкой, а
      // antd на клик по пункту сам зовёт onOpenChange(false, source:'menu') и
      // внутренний setOpen(false) (при контролируемом open он не в счёт).
      // ESC и клик снаружи приходят с source:'trigger' и закрывают как обычно.
      onOpenChange={(nextOpen, info) => {
        if (info.source !== 'menu') setOpen(nextOpen);
      }}
      menu={{
        items: files.map((f) => ({
          key: f.id,
          disabled: downloadingId !== null,
          label: (
            <div>
              <div>{f.filename}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {describeExtraFile(f)}
              </Typography.Text>
            </div>
          ),
        })),
        onClick: ({ key }) => {
          const f = files.find((x) => x.id === key);
          if (f) void download(f);
        },
      }}
    >
      <Button icon={<DownloadOutlined />} loading={downloadingId !== null}>
        {label}
      </Button>
    </Dropdown>
  );
}

function describeExtraFile(f: ExtraFile): string {
  const size = f.sizeBytes != null ? formatSize(f.sizeBytes) : null;
  // detectedKind заполнен только у файлов из зоны распознавания: там тип
  // определить не удалось. У второй зоны классификация не запускалась вовсе.
  const why = f.detectedKind === 'unknown' ? 'тип не определён' : 'без распознавания';
  return [size, why].filter(Boolean).join(' · ');
}
