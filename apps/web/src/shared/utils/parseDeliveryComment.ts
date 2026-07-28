// Парсер comment-поля приёмки, формируемого мобильным клиентом.
// Контракт (см. matcheck.mobile Stage2FormViewModel.buildCombinedComment):
//
//   1 Этап: "<текст>"
//   2 Этап: "<текст>"
//   Примечание: <текст>
//
// Любые «прочие» непустые строки без префикса считаются хвостом 2 Этапа —
// это backward-compat с приёмками, созданными до перехода мобильного на
// данный формат, чтобы не потерять старый текст в UI.
//
// Регексы совпадают с мобильными byte-в-byte. Если ни одна строка не дала
// маркер, hasStructure=false — UI должен отрисовать единый блок «как есть».

export interface ParsedDeliveryComment {
  stage1: string | null;
  stage2: string | null;
  note: string | null;
  /** True, если в исходном тексте найден хотя бы один из префиксов. */
  hasStructure: boolean;
}

const STAGE1_REGEX = /^1 Этап:\s*"(.*)"$/;
const STAGE2_REGEX = /^2 Этап:\s*"(.*)"$/;
const NOTE_REGEX = /^Примечание:\s*(.+)$/;

export function parseDeliveryComment(raw: string | null | undefined): ParsedDeliveryComment {
  if (!raw || raw.trim().length === 0) {
    return { stage1: null, stage2: null, note: null, hasStructure: false };
  }
  let stage1: string | null = null;
  let stage2: string | null = null;
  let note: string | null = null;
  let hasStructure = false;
  const leftovers: string[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (s.length === 0) continue;
    const m1 = STAGE1_REGEX.exec(s);
    if (m1) {
      stage1 = m1[1] ?? null;
      hasStructure = true;
      continue;
    }
    const m2 = STAGE2_REGEX.exec(s);
    if (m2) {
      stage2 = m2[1] ?? null;
      hasStructure = true;
      continue;
    }
    const mn = NOTE_REGEX.exec(s);
    if (mn) {
      note = (mn[1] ?? '').trim() || null;
      hasStructure = true;
      continue;
    }
    leftovers.push(s);
  }
  if (stage2 === null && leftovers.length > 0) {
    stage2 = leftovers.join('\n');
  }
  return { stage1, stage2, note, hasStructure };
}
