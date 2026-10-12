/**
 * Узкое описание pdfmake 0.3 — ровно то, чем пользуется domain/edo/upd-review-pdf.ts.
 *
 * @types/pdfmake не ставим намеренно: его interfaces.d.ts подключает
 * `/// <reference lib="dom" />`, и DOM-типы протекают во весь серверный
 * проект — например, BodyInit у fetch перестаёт принимать Buffer, и падает
 * typecheck s3.signer.ts. Описание документа здесь поэтому свободное.
 *
 * Пакет — CommonJS с `module.exports = new pdfmake()`: при динамическом
 * import() объект приходит в `default`.
 */
declare module 'pdfmake' {
  export type PdfContent = string | PdfContent[] | { [key: string]: unknown };

  export interface PdfFontFiles {
    normal: string;
    bold: string;
    italics: string;
    bolditalics: string;
  }

  export interface PdfDocumentDefinition {
    content: PdfContent;
    [key: string]: unknown;
  }

  export interface PdfCreated {
    getBuffer(): Promise<Buffer>;
  }

  export interface PdfMake {
    createPdf(definition: PdfDocumentDefinition): PdfCreated;
    setFonts(fonts: Record<string, PdfFontFiles>): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
  }

  const pdfmake: PdfMake;
  export default pdfmake;
}
