import { z } from 'zod';

export const InnSchema = z.string().regex(/^(\d{10}|\d{12})$/, 'INN must be 10 or 12 digits');
export const KppSchema = z
  .string()
  .regex(/^\d{9}$/, 'KPP must be 9 digits')
  .nullable()
  .optional();

export const CounterpartySchema = z.object({
  id: z.string().uuid(),
  inn: z.string(),
  kpp: z.string().nullable(),
  name: z.string(),
  address: z.string().nullable(),
  isSelf: z.boolean(),
  isSupplier: z.boolean(),
  isCustomer: z.boolean(),
  isCarrier: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Counterparty = z.infer<typeof CounterpartySchema>;

export const CounterpartyUpsertSchema = z.object({
  inn: InnSchema,
  kpp: KppSchema,
  name: z.string().min(1).max(500),
  address: z.string().max(500).nullable().optional(),
  isSelf: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
  isCustomer: z.boolean().optional(),
  isCarrier: z.boolean().optional(),
});
export type CounterpartyUpsert = z.infer<typeof CounterpartyUpsertSchema>;

export const CounterpartyListResponseSchema = z.object({
  items: z.array(CounterpartySchema),
  total: z.number(),
});
