// ИНН-заглушка для строк `counterparties`, у которых настоящего ИНН нет:
// подрядчик, созданный «на лету» (routes/counterparties.ts), и поставщик из
// справочника без ИНН (supplier-counterparty.ts).
//
// Формат: 0000 + 8 hex = 12 символов, помещается в varchar(12). У реальных
// юрлиц и ИП РФ ИНН с 0000 не начинается (первые две цифры — код региона), на
// этом держится isPlaceholderInn из @matcheck/contracts.
//
// Хвост hex может состоять из одних цифр или содержать две буквы — тогда после
// «оставить только цифры» выходит 12 или 10 цифр, похожих на ИНН. Поэтому
// нормализаторы ИНН (innDigits, normalizeInn, filterInn) отбрасывают заглушку
// ДО очистки, по префиксу, а не полагаются на её вид.

import { randomBytes } from 'node:crypto';
import { PLACEHOLDER_INN_PREFIX } from '@matcheck/contracts';

/** Новая заглушка. Шанс совпадения — 1 к 16^8 ≈ 4·10⁹ на пару строк. */
export function generatePlaceholderInn(): string {
  return PLACEHOLDER_INN_PREFIX + randomBytes(4).toString('hex');
}
