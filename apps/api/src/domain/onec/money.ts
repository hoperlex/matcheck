/**
 * Десятичная арифметика для выгрузки в 1С — на BigInt, без float.
 *
 * Деньги и количества приходят из Postgres строками numeric ("123.4500") и
 * уходят в 1С строками. Через Number(...) их гонять нельзя: qty × price при
 * четырёх знаках у обоих множителей даёт восемь знаков, и float на этом
 * масштабе уже округляет не так, как Postgres ROUND. Отсюда простое
 * представление «целое + масштаб» и округление half-up от нуля — ровно как
 * ROUND(numeric) в Postgres.
 */

export type Dec = { v: bigint; s: number };

const DEC_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Разбор строки numeric. null/пустое/мусор → null (а не ноль). */
export function parseDec(raw: string | number | null | undefined): Dec | null {
  if (raw === null || raw === undefined) return null;
  const str = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : '') : raw.trim();
  const m = DEC_RE.exec(str);
  if (!m) return null;
  const frac = m[3] ?? '';
  const v = BigInt(`${m[2]}${frac}`);
  return { v: m[1] ? -v : v, s: frac.length };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function rescaleUp(a: Dec, s: number): Dec {
  return s <= a.s ? a : { v: a.v * pow10(s - a.s), s };
}

export function add(a: Dec, b: Dec): Dec {
  const s = Math.max(a.s, b.s);
  return { v: rescaleUp(a, s).v + rescaleUp(b, s).v, s };
}

export function sub(a: Dec, b: Dec): Dec {
  return add(a, { v: -b.v, s: b.s });
}

export function mul(a: Dec, b: Dec): Dec {
  return { v: a.v * b.v, s: a.s + b.s };
}

/** Деление на 10^n без потерь: просто сдвиг масштаба. */
export function shift(a: Dec, n: number): Dec {
  return { v: a.v, s: a.s + n };
}

/** Округление до s знаков, half-up от нуля (как ROUND(numeric, s) в Postgres). */
export function round(a: Dec, s: number): Dec {
  if (a.s <= s) return rescaleUp(a, s);
  const d = pow10(a.s - s);
  const neg = a.v < 0n;
  const abs = neg ? -a.v : a.v;
  let q = abs / d;
  const r = abs % d;
  if (r * 2n >= d) q += 1n;
  return { v: neg ? -q : q, s };
}

export function abs(a: Dec): Dec {
  return a.v < 0n ? { v: -a.v, s: a.s } : a;
}

export function cmp(a: Dec, b: Dec): number {
  const s = Math.max(a.s, b.s);
  const x = rescaleUp(a, s).v;
  const y = rescaleUp(b, s).v;
  return x === y ? 0 : x < y ? -1 : 1;
}

export function isZero(a: Dec): boolean {
  return a.v === 0n;
}

/** Строка с ровно s знаками после точки (сначала округление). */
export function format(a: Dec, s: number): string {
  const r = round(a, s);
  const neg = r.v < 0n;
  const digits = (neg ? -r.v : r.v).toString().padStart(s + 1, '0');
  const int = s === 0 ? digits : digits.slice(0, -s);
  const frac = s === 0 ? '' : `.${digits.slice(-s)}`;
  return `${neg ? '-' : ''}${int}${frac}`;
}

export const ZERO: Dec = { v: 0n, s: 0 };
