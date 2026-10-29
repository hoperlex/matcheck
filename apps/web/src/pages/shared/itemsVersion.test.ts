import { describe, expect, it } from 'vitest';
import { advanceItemsVersion } from './itemsVersion';

describe('advanceItemsVersion', () => {
  it('ответ на «текущая + 1» — форма совпадает с сервером, версия сдвигается', () => {
    expect(advanceItemsVersion(4, 5)).toBe(5);
  });

  it('между снимком формы и действием кто-то сохранил — версия остаётся прежней', () => {
    // Привязка вернула v+2: строк из чужого сохранения в форме нет, и с новой
    // версией она молча затёрла бы их следующим «Сохранить».
    expect(advanceItemsVersion(4, 6)).toBe(4);
  });

  it('поллинг уже перечитал форму на эту версию — ничего не меняется', () => {
    expect(advanceItemsVersion(5, 5)).toBe(5);
  });

  it('форма ещё не взяла строки с сервера — версии нет', () => {
    expect(advanceItemsVersion(null, 1)).toBeNull();
  });
});
