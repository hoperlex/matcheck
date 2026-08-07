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

  const content =
    'BT /F1 12 Tf 40 780 Td 14 TL\n' +
    lines.map((l) => `<${encode(l)}> Tj T*`).join('\n') +
    '\nET';

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

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
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
