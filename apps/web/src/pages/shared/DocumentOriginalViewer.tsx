import { useEffect, useState } from 'react';
import { Button, Image, message, Tooltip, Typography } from 'antd';
import {
  DownloadOutlined,
  FileExcelOutlined,
  FilePdfOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { SourceDocumentPagesResponse } from '@matcheck/contracts';
import { api, apiDownload } from '../../services/api';

/**
 * Просмотр ОРИГИНАЛА документа: скан, PDF или файл, который браузер показать
 * не умеет.
 *
 * Жил приватной функцией внутри SourceDocumentDetailModal (раздел
 * «Документы») и был доступен только оттуда. Вынесен, чтобы тот же
 * просмотрщик открывался из карточки приёмки: менеджер сверяет материалы с
 * бумагой, не уходя искать документ в другой раздел.
 */

// Минимальный набор полей attachment, которого хватает для рендера превью.
// Берём подмножество SourceAttachment — компонент не зависит от других
// полей DTO (role/s3Key и пр.), это упрощает тесты и переиспользование.
export type AttachmentLike = {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
};

/**
 * Чем рисовать вложение. Классификация ПОЛОЖИТЕЛЬНАЯ: каждый исход требует
 * явного признака, и всё неопознанное честно уходит в карточку скачивания.
 *
 * Раньше правило было обратным — «любой image/* картинка, всё остальное
 * PDF». На этом ломались два класса файлов: HEIC (его принимает загрузка
 * накладных, а Chrome не рисует — выходила битая картинка) и вложение без
 * mime с незнакомым расширением (уезжало в PDF-iframe пустым кадром).
 */
export type AttachmentKind = 'image' | 'pdf' | 'excel' | 'download';

// Форматы, которые действительно рисует браузер. HEIC/HEIF сюда не входят
// намеренно: Safari их показывает, Chrome и Firefox — нет, а документы
// смотрят в портале.
const BROWSER_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
]);

// .jfif и .jfi — обычный JPEG под другим именем (так его сохраняют Outlook и
// Windows), .pjpeg — progressive JPEG. Запасной путь для вложений без mime.
const BROWSER_IMAGE_EXT = /\.(jpe?g|jfif|jfi|pjpeg|png|webp|gif|bmp|avif)$/i;

export function classifyAttachment(a: {
  filename: string;
  mimeType?: string | null;
}): AttachmentKind {
  const mime = a.mimeType?.toLowerCase().trim() ?? '';
  // Excel проверяем ПЕРВЫМ: .xls с ошибочно заявленным image/* иначе уйдёт в
  // <img> и покажет сломанную картинку вместо кнопки «Скачать».
  if (
    /\.xlsx?$/i.test(a.filename) ||
    mime.includes('spreadsheetml') ||
    mime === 'application/vnd.ms-excel'
  ) {
    return 'excel';
  }
  if (mime === 'application/pdf' || /\.pdf$/i.test(a.filename)) return 'pdf';
  if (BROWSER_IMAGE_MIME.has(mime)) return 'image';
  // Расширение — запасной путь: mime в БД nullable, у части старых вложений
  // его нет вовсе.
  if (!mime && BROWSER_IMAGE_EXT.test(a.filename)) return 'image';
  return 'download';
}

// Lightbox-паттерн: одно вложение крупно + полоса миниатюр снизу для
// переключения. Раньше стекали все вложения 1/N высоты — для ТН с
// 3–4 фото каждое уменьшалось до нечитаемого размера.
export function DocumentOriginalViewer({
  attachments,
  id,
  compact,
  showDownload = false,
}: {
  attachments: ReadonlyArray<AttachmentLike>;
  id: string;
  // compact=true — внутри Splitter (правая/нижняя панель), занимает 100% высоты;
  // compact=false — внутри Tabs (узкий экран), фиксированная высота как раньше.
  compact: boolean;
  /**
   * Показывать кнопку «Скачать оригинал» под просмотрщиком.
   *
   * Только для тех вложений, которые ОТРИСОВАНЫ (изображение, PDF): у
   * карточки скачивания своя кнопка внутри, и вторая рядом была бы дублем.
   * По умолчанию выключено — в разделе «Документы» интерфейс остаётся
   * прежним.
   */
  showDownload?: boolean;
}) {
  const [activeId, setActiveId] = useState<string | null>(attachments[0]?.id ?? null);

  // Страницы этого документа внутри файла. Пакет из одного PDF режут на
  // несколько УПД, а вложением к карточке остаётся файл целиком — без этой
  // подсказки вьюер открывал двадцатистраничный скан с первой страницы, и
  // менеджер видел на экране чужой лист вместо позиций своего документа.
  // Отдельный маршрут: то же поле в DTO документа уехало бы и на планшет.
  const pagesQuery = useQuery({
    queryKey: ['source-document-pages', id],
    queryFn: () => api.get<SourceDocumentPagesResponse>(`/source-documents/${id}/pages`),
    staleTime: 5 * 60_000,
  });

  // Если открыли другой документ — attachments сменились, нужно сбросить
  // активный на первый. Сравниваем по списку id, потому что массив
  // attachments — readonly прокси с новой ссылкой на каждом ререндере.
  useEffect(() => {
    if (attachments.length === 0) {
      setActiveId(null);
      return;
    }
    const first = attachments[0];
    if (first && !attachments.some((a) => a.id === activeId)) {
      setActiveId(first.id);
    }
  }, [attachments, activeId]);

  if (attachments.length === 0 || !activeId) return null;
  const active = attachments.find((a) => a.id === activeId) ?? attachments[0];
  if (!active) return null;
  const activeIndex = attachments.findIndex((a) => a.id === active.id);
  const activeUrl = `/api/v1/source-documents/${id}/file/raw?attachmentId=${active.id}`;
  const activePages =
    pagesQuery.data?.attachments.find((a) => a.attachmentId === active.id)?.pages ?? [];
  const pagesLabel = formatPagesLabel(activePages);
  // Chrome PDF Viewer понимает page= внутри того же fragment. Отдельный «#»
  // ломает якорь целиком, поэтому дописываем параметр к существующему.
  const pdfFragment = `#toolbar=1&navpanes=0${activePages.length > 0 ? `&page=${activePages[0]}` : ''}`;
  const kind = classifyAttachment(active);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        height: compact ? '100%' : '75vh',
        minHeight: 320,
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Typography.Text
          type="secondary"
          style={{ fontSize: 11, display: 'block', marginBottom: 2 }}
        >
          {attachments.length > 1
            ? `Фото ${activeIndex + 1} из ${attachments.length} · ${active.filename}`
            : active.filename}
          {pagesLabel ? ` · ${pagesLabel}` : ''}
        </Typography.Text>
        {kind === 'image' ? (
          // antd Image даёт встроенный lightbox (zoom/rotate/fullscreen) —
          // для скана накладной это удобнее, чем image в <iframe>, где у
          // Chrome нет ни зума, ни поворота. Меняем active.id ⇒ Image
          // перегружает src.
          <div
            key={active.id}
            style={{
              flex: 1,
              minHeight: 200,
              border: '1px solid #f0f0f0',
              background: '#fafafa',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            <Image
              src={activeUrl}
              alt={active.filename}
              wrapperStyle={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              preview={{ mask: 'Открыть для зума' }}
            />
          </div>
        ) : kind === 'excel' ? (
          // Excel в браузере inline не открывается (нет встроенного
          // viewer'а ни у Chrome, ни у Firefox). Раньше URL попадал в
          // <iframe> — браузер при загрузке iframe запускал автоматическое
          // скачивание xlsx. Теперь рендерим карточку: иконка + имя +
          // размер + явная кнопка «Скачать». Распознанные позиции уже
          // видны в левой/верхней панели «Позиции».
          <DownloadPreviewCard
            id={id}
            attachment={active}
            icon={<FileExcelOutlined style={{ fontSize: 64, color: '#22863a' }} />}
            caption="Excel-файл"
            hint="Браузер не отображает Excel внутри страницы. Реквизиты и позиции документа уже распознаны и доступны в панели «Позиции»."
          />
        ) : kind === 'pdf' ? (
          <iframe
            key={active.id}
            // #toolbar=1&navpanes=0 — Chrome PDF Viewer прячет левую панель
            // с миниатюрами страниц, освобождая место для самого документа.
            src={`${activeUrl}${pdfFragment}`}
            title={active.filename}
            style={{
              flex: 1,
              width: '100%',
              minHeight: 200,
              border: '1px solid #f0f0f0',
            }}
          />
        ) : (
          // HEIC/HEIF, TIFF и всё, чего браузер не рисует. Раньше такие
          // файлы уходили в <img> (битая картинка) или в PDF-iframe (пустой
          // кадр) — человек видел поломку вместо честного «скачайте».
          <DownloadPreviewCard
            id={id}
            attachment={active}
            icon={<FileTextOutlined style={{ fontSize: 64, color: '#8c8c8c' }} />}
            caption="Файл"
            hint="Браузер не показывает этот формат. Скачайте файл, чтобы открыть его на компьютере."
          />
        )}
      </div>
      {/* Кнопка нужна только там, где показан сам документ: у карточки
          скачивания своя кнопка внутри. */}
      {showDownload && kind !== 'excel' && kind !== 'download' && (
        <DownloadButton id={id} attachment={active} block={false} />
      )}
      {attachments.length > 1 && (
        <ThumbBar attachments={attachments} activeId={activeId} onSelect={setActiveId} id={id} />
      )}
    </div>
  );
}

/**
 * «Стр. 17–20» для смежных страниц, «Стр. 15, 17» для разрывов.
 *
 * Диапазон не додумываем: сегмент собирается из адресов конкретных страниц, и
 * при пропуске посередине «17–20» соврало бы про два листа.
 */
function formatPagesLabel(pages: number[]): string {
  if (pages.length === 0) return '';
  if (pages.length === 1) return `Стр. ${pages[0]}`;
  const first = pages[0]!;
  const last = pages[pages.length - 1]!;
  const contiguous = pages.every((p, i) => p === first + i);
  return contiguous ? `Стр. ${first}–${last}` : `Стр. ${pages.join(', ')}`;
}

function formatFileSize(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}

async function downloadAttachment(id: string, attachment: AttachmentLike): Promise<void> {
  // download=1 заставляет сервер выставить Content-Disposition: attachment
  // даже для PDF/изображений; для xlsx attachment ставится автоматически
  // по mime-типу (см. routes/source-documents.ts). apiDownload сам
  // приклеивает префикс BASE='/api/v1' (см. services/api.ts), поэтому
  // здесь путь относительный — без `/api/v1/`, иначе получим двойной
  // префикс и 404 Route not found.
  const { blob, filename } = await apiDownload(
    `/source-documents/${id}/file/raw?attachmentId=${attachment.id}&download=1`,
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || attachment.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DownloadButton({
  id,
  attachment,
  block,
}: {
  id: string;
  attachment: AttachmentLike;
  block: boolean;
}) {
  const [downloading, setDownloading] = useState(false);
  const handleDownload = async () => {
    try {
      setDownloading(true);
      await downloadAttachment(id, attachment);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Не удалось скачать файл');
    } finally {
      setDownloading(false);
    }
  };
  return (
    <Button
      type={block ? 'primary' : 'default'}
      size={block ? 'middle' : 'small'}
      icon={<DownloadOutlined />}
      loading={downloading}
      onClick={handleDownload}
    >
      Скачать оригинал
    </Button>
  );
}

/**
 * Карточка для файла, который браузер не показывает: иконка, имя, размер и
 * явная кнопка «Скачать».
 *
 * Общая, а не «экселевская»: подпись и иконка приходят пропсами, иначе HEIC
 * показывался бы пользователю как «Excel-файл».
 */
function DownloadPreviewCard({
  id,
  attachment,
  icon,
  caption,
  hint,
}: {
  id: string;
  attachment: AttachmentLike;
  icon: React.ReactNode;
  caption: string;
  hint: string;
}) {
  const size = formatFileSize(attachment.sizeBytes);
  return (
    <div
      style={{
        flex: 1,
        minHeight: 200,
        border: '1px solid #f0f0f0',
        background: '#fafafa',
        borderRadius: 4,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        gap: 12,
      }}
    >
      {icon}
      <Typography.Text strong style={{ textAlign: 'center', wordBreak: 'break-word' }}>
        {attachment.filename}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {caption}
        {size ? ` · ${size}` : ''}
      </Typography.Text>
      <DownloadButton id={id} attachment={attachment} block />
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11, textAlign: 'center', maxWidth: 380 }}
      >
        {hint}
      </Typography.Text>
    </div>
  );
}

function ThumbBar({
  attachments,
  activeId,
  onSelect,
  id,
}: {
  attachments: ReadonlyArray<AttachmentLike>;
  activeId: string;
  onSelect: (id: string) => void;
  id: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        overflowX: 'auto',
        paddingBottom: 4,
        flexShrink: 0,
      }}
    >
      {attachments.map((a, i) => {
        const kind = classifyAttachment(a);
        const isActive = a.id === activeId;
        const thumbUrl = `/api/v1/source-documents/${id}/file/raw?attachmentId=${a.id}`;
        return (
          <Tooltip key={a.id} title={a.filename} placement="top">
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(a.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(a.id);
                }
              }}
              style={{
                flexShrink: 0,
                width: 64,
                height: 64,
                border: isActive ? '2px solid #1677ff' : '1px solid #d9d9d9',
                borderRadius: 4,
                cursor: 'pointer',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                background: '#fafafa',
                transition: 'border-color 0.15s',
              }}
            >
              {kind === 'image' ? (
                <img
                  src={thumbUrl}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : kind === 'pdf' ? (
                <FilePdfOutlined style={{ fontSize: 28, color: '#d4380d' }} />
              ) : kind === 'excel' ? (
                // Не подставляем xlsx-URL в <img> — браузер всё равно не
                // сможет его декодировать, а запрос дёрнет /file/raw → 200
                // и при некоторых настройках вызовет лишнюю сетевую работу.
                <FileExcelOutlined style={{ fontSize: 28, color: '#22863a' }} />
              ) : (
                <FileTextOutlined style={{ fontSize: 28, color: '#8c8c8c' }} />
              )}
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  background: 'rgba(0,0,0,0.55)',
                  color: '#fff',
                  fontSize: 10,
                  textAlign: 'center',
                  padding: '1px 2px',
                  lineHeight: 1.2,
                }}
              >
                {i + 1}
              </div>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}
