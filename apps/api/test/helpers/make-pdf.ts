/**
 * Минимальный PDF с текстовым слоем — для тестов классификатора.
 *
 * Реальные фикстуры лежат в test/fixtures/upd-debug, но для проверок вида «в
 * тексте есть слово X» таскать чужие документы не нужно: классификатору важен
 * только извлекаемый текст.
 *
 * Кириллица требует ToUnicode-таблицы: WinAnsiEncoding её не содержит, а
 * извлечение текста в pdf.js идёт именно через ToUnicode. Поэтому каждому
 * символу выдаётся свой код, а CMap переводит код обратно в символ — ровно то,
 * что делает 1С и любой другой генератор с нестандартным шрифтом.
 */
export function makeTextPdf(lines: string[]): Buffer {
  return makeTextPdfPages([lines]);
}

/**
 * То же, но страница на каждый массив строк — для проверок, где важно, на
 * какой странице стоит текст. Алфавит общий на файл (≤ 93 символа). Порядок
 * объектов подобран так, что одна страница даёт ровно те же байты, что и
 * прежний одностраничный makeTextPdf.
 */
export function makeTextPdfPages(pages: string[][]): Buffer {
  const lines = pages.flat();
  const alphabet = [...new Set(lines.join('').split(''))];
  if (alphabet.length > 0x7e - 0x21) throw new Error('makeTextPdf: слишком разнообразный текст');
  // Коды берём из печатного ASCII: у стандартного Helvetica на них есть глифы,
  // и pdf.js доходит до текста. Реальные символы подставляет ToUnicode ниже.
  const codeOf = new Map(alphabet.map((ch, i) => [ch, 0x21 + i]));
  const encode = (s: string) =>
    s
      .split('')
      .map((ch) => codeOf.get(ch)!.toString(16).padStart(2, '0'))
      .join('');

  const contents = pages.map(
    (pageLines) =>
      'BT /F1 12 Tf 40 780 Td 14 TL\n' +
      pageLines.map((l) => `<${encode(l)}> Tj T*`).join('\n') +
      '\nET',
  );

  const bfchar = alphabet
    .map(
      (ch) =>
        `<${codeOf.get(ch)!.toString(16).padStart(2, '0')}> <${ch
          .charCodeAt(0)
          .toString(16)
          .padStart(4, '0')}>`,
    )
    .join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<00> <ff>
endcodespacerange
${alphabet.length} beginbfchar
${bfchar}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  // Нумерация: 1 каталог, 2 дерево страниц, 3…2+n страницы, 3+n шрифт,
  // 4+n…3+2n содержимое страниц, 4+2n ToUnicode.
  const n = pages.length;
  const fontObj = 3 + n;
  const cmapObj = 4 + 2 * n;
  const pageObj = (i: number) => 3 + i;
  const contentObj = (i: number) => 4 + n + i;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>`,
    ...pages.map(
      (_, i) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`,
    ),
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${cmapObj} 0 R >>`,
    ...contents.map(
      (content) =>
        `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    ),
    `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>\nstream\n${cmap}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
