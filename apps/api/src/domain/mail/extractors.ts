import ExcelJS from 'exceljs';
import mammoth from 'mammoth';

export type ExtractResult = {
  markdown: string;
  format: 'xlsx' | 'docx' | 'csv' | 'html' | 'text';
};

export async function extractToMarkdown(
  buffer: Buffer,
  filenameOrMime: string,
): Promise<ExtractResult> {
  const f = filenameOrMime.toLowerCase();
  if (f.endsWith('.xlsx') || f.endsWith('.xlsm') || f.includes('spreadsheet')) {
    return { markdown: await xlsxToMarkdown(buffer), format: 'xlsx' };
  }
  if (f.endsWith('.docx') || f.includes('wordprocessing')) {
    return { markdown: await docxToMarkdown(buffer), format: 'docx' };
  }
  if (f.endsWith('.csv') || f === 'text/csv') {
    return { markdown: csvToMarkdown(buffer.toString('utf-8')), format: 'csv' };
  }
  if (f.endsWith('.html') || f.endsWith('.htm') || f.includes('html')) {
    return { markdown: stripHtml(buffer.toString('utf-8')), format: 'html' };
  }
  return { markdown: buffer.toString('utf-8'), format: 'text' };
}

async function xlsxToMarkdown(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS expects ArrayBuffer-like; cast through unknown to satisfy strict TS.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const out: string[] = [];
  for (const ws of wb.worksheets) {
    out.push(`## Sheet: ${ws.name}`);
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        cells.push(
          v === null || v === undefined
            ? ''
            : typeof v === 'object' && 'text' in (v as object)
              ? String((v as { text: unknown }).text)
              : String(v),
        );
      });
      rows.push(cells);
    });
    if (rows.length === 0) continue;
    const header = rows[0] ?? [];
    out.push(`| ${header.join(' | ')} |`);
    out.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const r of rows.slice(1)) {
      out.push(`| ${r.join(' | ')} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

async function docxToMarkdown(buffer: Buffer): Promise<string> {
  // mammoth v1 has no convertToMarkdown — use convertToHtml then strip tags.
  const result = await mammoth.convertToHtml({ buffer });
  return stripHtml(result.value);
}

function csvToMarkdown(csv: string): string {
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return '';
  const split = (line: string) => line.split(/[;,\t]/).map((c) => c.trim());
  const header = split(lines[0]!);
  const body = lines.slice(1).map(split);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function stripHtml(html: string): string {
  // Упрощённое преобразование HTML → markdown.
  // Non-breaking space variants written as escape sequences to avoid irregular whitespace.
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<tr[^>]*>/gi, '\n')
    .replace(/<\/tr>/gi, '')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<\/(td|th)>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(new RegExp('\u00a0|\u202f|&nbsp;', 'g'), ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
