import { describe, expect, it } from 'vitest';
import { PublicRejectReasonSchema } from '@matcheck/contracts';
import { rejectLabel } from './rejectLabel';

describe('тексты отказа для поставщика', () => {
  it('HEIC объясняет, что делать, а не просто «не принят»', () => {
    const text = rejectLabel('heic_unsupported');
    expect(text).toContain('HEIC');
    // Инструкция обязательна: поставщик с айфоном иначе просто отправит то же
    // самое ещё раз.
    expect(text).toContain('Наиболее совместимый');
  });

  it('у каждого кода из контракта есть свой текст', () => {
    // Защита от рассинхрона: код добавили на сервере, а форма показывает
    // безликое «не принят» — поставщик не понимает, что исправлять.
    for (const reason of PublicRejectReasonSchema.options) {
      expect(rejectLabel(reason), reason).not.toBe('не принят');
    }
  });

  it('неизвестный код не роняет форму', () => {
    expect(rejectLabel('что-то новое')).toBe('не принят');
  });
});
