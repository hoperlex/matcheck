import { useState } from 'react';
import { Alert, Button, List, Typography, message } from 'antd';
import { FileTextOutlined } from '@ant-design/icons';
import type { ExtraFile } from '@matcheck/contracts';
import { apiGetBundleExtraFileUrl, apiGetExtraFileUrl } from '../../services/api';
import { formatSize } from './upload/FileDropList';

/**
 * Дополнительные документы поставки: файлы, сохранённые без распознавания.
 *
 * Два источника — карточка документа и раздел комплектов без документов, —
 * поэтому ссылку выдаёт разный маршрут: в карточке права наследуются от
 * документа, в разделе документа нет вовсе. Отсюда `documentId`/`bundleId`.
 *
 * Ссылка запрашивается по клику, а не заранее: presign живёт час, а список
 * может провисеть в открытом окне дольше.
 */
export function ExtraFilesBlock({
  files,
  documentId,
  compact,
}: {
  files: ExtraFile[];
  documentId?: string;
  compact?: boolean;
}) {
  const list = (
    <ExtraFilesList files={files} documentId={documentId} />
  );
  if (compact) return list;
  return (
    <Alert
      style={{ marginBottom: 12 }}
      type="info"
      showIcon={false}
      message={`Дополнительные документы поставки: ${files.length}`}
      description={
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Эти файлы не распознавались — сертификаты, паспорта качества и прочие приложения.
          </Typography.Paragraph>
          {list}
        </>
      }
    />
  );
}

function ExtraFilesList({ files, documentId }: { files: ExtraFile[]; documentId?: string }) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function open(f: ExtraFile) {
    setBusyId(f.id);
    try {
      const link = documentId
        ? await apiGetExtraFileUrl(documentId, f.id)
        : await apiGetBundleExtraFileUrl(f.bundleId, f.id);
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

function describeExtraFile(f: ExtraFile): string {
  const size = f.sizeBytes != null ? formatSize(f.sizeBytes) : null;
  // detectedKind заполнен только у файлов из зоны распознавания: там тип
  // определить не удалось. У второй зоны классификация не запускалась вовсе.
  const why = f.detectedKind === 'unknown' ? 'тип не определён' : 'без распознавания';
  return [size, why].filter(Boolean).join(' · ');
}
