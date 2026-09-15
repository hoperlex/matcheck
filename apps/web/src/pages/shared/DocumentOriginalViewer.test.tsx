// @vitest-environment jsdom
/**
 * Классификация формата вложения.
 *
 * Раньше правило было отрицательным: «любой image/* — картинка, всё
 * остальное — PDF». На нём ломались два класса файлов. HEIC (его принимает
 * загрузка накладных) уходил в <img> и показывался битой картинкой, потому
 * что Chrome и Firefox этот формат не рисуют. Вложение без mime с незнакомым
 * расширением уезжало в PDF-iframe и давало пустой кадр. Теперь каждый исход
 * требует явного признака, а всё неопознанное честно предлагает скачивание.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('../../services/api', () => ({
  // Просмотрщик спрашивает у /pages, какие страницы файла принадлежат
  // документу. Для классификации это неважно — отдаём пустой ответ.
  api: { get: vi.fn().mockResolvedValue({ attachments: [] }) },
  apiDownload: vi.fn().mockResolvedValue({ blob: new Blob(), filename: 'f.pdf' }),
}));

const { DocumentOriginalViewer, classifyAttachment } = await import('./DocumentOriginalViewer');

const att = (over: Partial<{ id: string; filename: string; mimeType: string | null; sizeBytes: number | null }> = {}) => ({
  id: 'a1',
  filename: 'doc.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  ...over,
});

function show(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(cleanup);

describe('classifyAttachment', () => {
  it('браузерные картинки — image, HEIC и TIFF — download', () => {
    expect(classifyAttachment({ filename: 'a.jpg', mimeType: 'image/jpeg' })).toBe('image');
    expect(classifyAttachment({ filename: 'a.png', mimeType: 'image/png' })).toBe('image');
    expect(classifyAttachment({ filename: 'a.webp', mimeType: 'image/webp' })).toBe('image');
    // Принимается загрузкой накладных, но браузером не рисуется.
    expect(classifyAttachment({ filename: 'a.heic', mimeType: 'image/heic' })).toBe('download');
    expect(classifyAttachment({ filename: 'a.tiff', mimeType: 'image/tiff' })).toBe('download');
  });

  it('вложение без mime опознаётся по расширению', () => {
    // .jfif — обычный JPEG, так его сохраняют Outlook и Windows.
    expect(classifyAttachment({ filename: 'скан.jfif', mimeType: null })).toBe('image');
    expect(classifyAttachment({ filename: 'упд.pdf', mimeType: null })).toBe('pdf');
    expect(classifyAttachment({ filename: 'дамп.bin', mimeType: null })).toBe('download');
  });

  it('Excel определяется раньше картинки — иначе .xls с чужим mime уйдёт в <img>', () => {
    expect(classifyAttachment({ filename: 'смета.xls', mimeType: 'image/jpeg' })).toBe('excel');
    expect(classifyAttachment({ filename: 'смета.xlsx', mimeType: null })).toBe('excel');
  });
});

describe('DocumentOriginalViewer', () => {
  it('PDF открывается во встроенном вьюере браузера', () => {
    const { container } = show(<DocumentOriginalViewer attachments={[att()]} id="d1" compact />);
    const frame = container.querySelector('iframe');
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute('src')).toContain('/file/raw?attachmentId=a1');
    expect(frame!.getAttribute('src')).toContain('#toolbar=1&navpanes=0');
  });

  it('скан показывается картинкой с зумом', () => {
    const { container } = show(
      <DocumentOriginalViewer
        attachments={[att({ filename: 'скан.jpg', mimeType: 'image/jpeg' })]}
        id="d1"
        compact
      />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toContain('/file/raw?attachmentId=a1');
  });

  it('Excel — карточка со скачиванием, а не пустой iframe', () => {
    const { container } = show(
      <DocumentOriginalViewer
        attachments={[
          att({
            filename: 'упд.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }),
        ]}
        id="d1"
        compact
      />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/Excel-файл/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Скачать оригинал/ })).toBeTruthy();
  });

  it('HEIC не выдаётся за Excel и не уходит в iframe', () => {
    const { container } = show(
      <DocumentOriginalViewer
        attachments={[att({ filename: 'IMG_0001.heic', mimeType: 'image/heic' })]}
        id="d1"
        compact
      />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    // Общая карточка, а не переиспользованная экселевская с чужой подписью.
    expect(screen.queryByText(/Excel-файл/)).toBeNull();
    expect(screen.getByText(/Браузер не показывает этот формат/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Скачать оригинал/ })).toBeTruthy();
  });

  it('вложение без mime с незнакомым расширением предлагает скачивание', () => {
    const { container } = show(
      <DocumentOriginalViewer
        attachments={[att({ filename: 'dump.bin', mimeType: null })]}
        id="d1"
        compact
      />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/Браузер не показывает этот формат/)).toBeTruthy();
  });

  it('несколько вложений — полоса миниатюр, клик переключает активное', () => {
    const { container } = show(
      <DocumentOriginalViewer
        attachments={[
          att({ id: 'a1', filename: 'стр1.jpg', mimeType: 'image/jpeg' }),
          att({ id: 'a2', filename: 'стр2.jpg', mimeType: 'image/jpeg' }),
        ]}
        id="d1"
        compact
      />,
    );
    expect(screen.getByText(/Фото 1 из 2 · стр1.jpg/)).toBeTruthy();

    const thumbs = screen.getAllByRole('button');
    fireEvent.click(thumbs[1]!);

    expect(screen.getByText(/Фото 2 из 2 · стр2.jpg/)).toBeTruthy();
    expect(container.querySelector('img')!.getAttribute('src')).toContain('attachmentId=a2');
  });

  it('showDownload добавляет кнопку отрисованному документу', () => {
    show(<DocumentOriginalViewer attachments={[att()]} id="d1" compact showDownload />);
    expect(screen.getByRole('button', { name: /Скачать оригинал/ })).toBeTruthy();
  });

  it('без showDownload у PDF кнопки нет — раздел «Документы» не меняется', () => {
    show(<DocumentOriginalViewer attachments={[att()]} id="d1" compact />);
    expect(screen.queryByRole('button', { name: /Скачать оригинал/ })).toBeNull();
  });

  it('у Excel при showDownload кнопка ровно одна — своя, из карточки', () => {
    show(
      <DocumentOriginalViewer
        attachments={[att({ filename: 'упд.xlsx', mimeType: 'application/vnd.ms-excel' })]}
        id="d1"
        compact
        showDownload
      />,
    );
    expect(screen.getAllByRole('button', { name: /Скачать оригинал/ })).toHaveLength(1);
  });
});
