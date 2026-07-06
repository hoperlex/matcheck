import { describe, it, expect } from 'vitest';
import { ReviewRequestSchema } from '@matcheck/contracts';
import { canSeeReview, canReview } from '../src/lib/review.js';

/**
 * Unit-тесты отметки проверки качества (роль «Мониторинг»).
 *
 * Покрываем то, что тестируется без БД/HTTP:
 *   1. Контракт запроса ReviewRequestSchema — для «Есть замечания» (issues)
 *      комментарий обязателен, снятия отметки (state:null) нет.
 *   2. Видимость review-полей (canSeeReview) — только admin/manager/monitor.
 *
 * Гейт зрелости (422 для черновиков), read-only guard монитора и запись в БД —
 * инлайн-логика роутов; покрываются ручным E2E из плана.
 */

describe('ReviewRequestSchema — валидация тела PATCH .../review', () => {
  it('approved без комментария — валидно (комментарий необязателен)', () => {
    expect(ReviewRequestSchema.safeParse({ state: 'approved' }).success).toBe(true);
  });

  it('approved с комментарием — валидно', () => {
    expect(ReviewRequestSchema.safeParse({ state: 'approved', note: 'всё ок' }).success).toBe(true);
  });

  it('issues с комментарием — валидно', () => {
    const r = ReviewRequestSchema.safeParse({ state: 'issues', note: 'нечитаемое фото документа' });
    expect(r.success).toBe(true);
  });

  it('issues БЕЗ комментария — невалидно (комментарий обязателен)', () => {
    expect(ReviewRequestSchema.safeParse({ state: 'issues' }).success).toBe(false);
  });

  it('issues с пустым/пробельным комментарием — невалидно', () => {
    expect(ReviewRequestSchema.safeParse({ state: 'issues', note: '' }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ state: 'issues', note: '   ' }).success).toBe(false);
  });

  it('неизвестный state — невалидно (только approved/issues, снятия нет)', () => {
    expect(ReviewRequestSchema.safeParse({ state: 'rejected' }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ state: null }).success).toBe(false);
  });

  it('слишком длинный комментарий (>2000) — невалидно', () => {
    const long = 'x'.repeat(2001);
    expect(ReviewRequestSchema.safeParse({ state: 'issues', note: long }).success).toBe(false);
  });
});

describe('canSeeReview — видимость review-полей только для менеджмента', () => {
  it('admin/manager/monitor — видят', () => {
    expect(canSeeReview('admin')).toBe(true);
    expect(canSeeReview('manager')).toBe(true);
    expect(canSeeReview('monitor')).toBe(true);
  });

  it('contractor/inspector_kpp — НЕ видят', () => {
    expect(canSeeReview('contractor')).toBe(false);
    expect(canSeeReview('inspector_kpp')).toBe(false);
  });

  it('пустая/отсутствующая роль (в т.ч. анонимный share) — НЕ видит', () => {
    expect(canSeeReview(undefined)).toBe(false);
    expect(canSeeReview(null)).toBe(false);
    expect(canSeeReview('')).toBe(false);
  });

  it('canReview совпадает с canSeeReview (ставить может тот же менеджмент)', () => {
    for (const role of ['admin', 'manager', 'monitor', 'contractor', 'inspector_kpp']) {
      expect(canReview(role)).toBe(canSeeReview(role));
    }
  });
});
