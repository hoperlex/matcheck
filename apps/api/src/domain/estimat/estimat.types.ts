import { z } from 'zod';
import type { EstimatOrderContractor } from '../../db/schema.js';

/**
 * Разбор ответов внешнего API EstiMat (контракт 1.6.0). Схемы без `.strict()`:
 * контракт расширяется аддитивно, неизвестные поля отбрасываются молча.
 */

const nullableString = z.string().nullable();

/** ISO-время → Date; пустая и неразборчивая строка — отказ строки целиком. */
const isoDate = z.string().transform((v, ctx) => {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `не дата: ${v.slice(0, 40)}` });
    return z.NEVER;
  }
  return new Date(t);
});
const nullableIsoDate = isoDate.nullable();

/** ИНН — только цифры, 10 или 12 знаков; иначе null (сырое значение остаётся в raw). */
export function innDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 || digits.length === 12 ? digits : null;
}

/**
 * Сумма приходит числом JSON. Превращаем в строку decimal с копейками сразу и
 * дальше считаем только в SQL (numeric), без float-арифметики. Значение с долями
 * копейки — ошибка контракта, а не повод округлять молча.
 */
export function toDecimalString(amount: number): string | null {
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6 * Math.max(1, Math.abs(amount))) return null;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const rub = Math.trunc(abs / 100);
  const kop = String(abs % 100).padStart(2, '0');
  return `${sign}${rub}.${kop}`;
}

const contractorSchema = z.object({
  id: z.string(),
  name: z.string(),
  inn: nullableString.optional().transform((v) => v ?? null),
  type: nullableString.optional().transform((v) => v ?? null),
});

const orderRowSchema = z.object({
  id: z.string().uuid(),
  orderNo: z.number().int().nullable(),
  subNo: z.number().int().nullable(),
  projectId: z.string().uuid().nullable(),
  projectCode: nullableString,
  projectName: nullableString,
  contractors: z.array(contractorSchema),
  sourcingStatus: z.string().min(1),
  procurementMethod: nullableString.optional().transform((v) => v ?? null),
  acquisitionType: nullableString.optional().transform((v) => v ?? null),
  supplierName: nullableString,
  supplierInn: nullableString,
  amount: z.number().nullable(),
  contractNumber: nullableString.optional().transform((v) => v ?? null),
  contractDate: nullableString.optional().transform((v) => v ?? null),
  awardedAt: nullableIsoDate.optional().transform((v) => v ?? null),
  supplyApprovedAt: nullableIsoDate,
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type ParsedOrder = {
  id: string;
  orderNo: number | null;
  subNo: number | null;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  contractors: EstimatOrderContractor[];
  sourcingStatus: string;
  procurementMethod: string | null;
  acquisitionType: string | null;
  supplierName: string | null;
  supplierInn: string | null;
  amount: string | null;
  contractNumber: string | null;
  contractDate: string | null;
  awardedAt: Date | null;
  supplyApprovedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  raw: Record<string, unknown>;
};

export type OrderRowParse =
  | { ok: true; order: ParsedOrder }
  /** id — если хотя бы он валиден: такой заказ считается увиденным. */
  | { ok: false; id: string | null; issue: string };

export function parseOrderRow(raw: unknown): OrderRowParse {
  const parsed = orderRowSchema.safeParse(raw);
  if (!parsed.success) {
    const idParse = z.object({ id: z.string().uuid() }).safeParse(raw);
    const first = parsed.error.issues[0];
    return {
      ok: false,
      id: idParse.success ? idParse.data.id : null,
      issue: first ? `${first.path.join('.') || 'строка'}: ${first.message}` : 'не разобрано',
    };
  }
  const r = parsed.data;
  const amount = r.amount === null ? null : toDecimalString(r.amount);
  if (r.amount !== null && amount === null) {
    return { ok: false, id: r.id, issue: `amount: не сумма в копейках (${r.amount})` };
  }
  return {
    ok: true,
    order: {
      id: r.id,
      orderNo: r.orderNo,
      subNo: r.subNo,
      projectId: r.projectId,
      projectCode: r.projectCode,
      projectName: r.projectName,
      contractors: r.contractors,
      sourcingStatus: r.sourcingStatus,
      procurementMethod: r.procurementMethod,
      acquisitionType: r.acquisitionType,
      supplierName: r.supplierName,
      supplierInn: innDigits(r.supplierInn),
      amount,
      contractNumber: r.contractNumber,
      contractDate: r.contractDate,
      awardedAt: r.awardedAt,
      supplyApprovedAt: r.supplyApprovedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      raw: raw as Record<string, unknown>,
    },
  };
}

/** Страница списка: строки разбираются по одной, чтобы плохая не роняла страницу. */
export const orderPageSchema = z.object({
  data: z.array(z.unknown()),
  meta: z.object({
    nextCursor: z.string().nullable(),
    warnings: z.array(z.string()).optional(),
  }),
});
export type OrderPage = z.infer<typeof orderPageSchema>;

export const capabilitiesSchema = z.object({
  data: z.object({
    scopes: z.array(z.string()),
    /** null — токену доступны все объекты; иначе он сужен до этого. */
    projectId: z.string().uuid().nullable(),
    expiresAt: z.string().nullable().optional(),
    apiVersion: z.string().optional(),
  }),
});
export type EstimatCapabilities = z.infer<typeof capabilitiesSchema>['data'];

const orderItemSchema = z.object({
  id: z.string(),
  materialName: z.string(),
  unit: z.string(),
  quantity: z.number(),
  deliveryDate: nullableString,
  contractorName: nullableString,
});
export const orderDetailSchema = z.object({
  data: z.object({ items: z.array(orderItemSchema) }),
});
export type EstimatOrderItemRaw = z.infer<typeof orderItemSchema>;

/** Тело отказа EstiMat: ветвиться по error и recovery.strategy, не по тексту. */
export const errorBodySchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  recovery: z
    .object({
      strategy: z.string().optional(),
      retryAfterSec: z.number().optional(),
      maxAttempts: z.number().optional(),
    })
    .optional(),
  details: z.unknown().optional(),
  requestId: z.string().optional(),
});
export type EstimatErrorBody = z.infer<typeof errorBodySchema>;
