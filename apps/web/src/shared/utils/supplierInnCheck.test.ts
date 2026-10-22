import { describe, expect, it } from 'vitest';
import { supplierInnCorrectionNote } from './supplierInnCheck';

describe('supplierInnCorrectionNote', () => {
  it('применённое исправление — короткая подпись и подробность с источником', () => {
    expect(
      supplierInnCorrectionNote({
        mode: 'on',
        decision: 'corrected',
        raw: '784224734',
        inn: '7842224734',
        source: 'directory',
      }),
    ).toEqual({
      short: 'ИНН исправлен по справочнику',
      full: 'ИНН поставщика исправлен при распознавании по справочнику: было 784224734, стало 7842224734',
    });
    expect(
      supplierInnCorrectionNote({
        mode: 'on',
        decision: 'corrected',
        raw: '7708535165',
        inn: '7708353165',
        source: 'edo',
      })?.short,
    ).toBe('ИНН исправлен по ЭДО');
  });

  it('shadow, непроверенный, верный и пустой след — без подписи', () => {
    expect(
      supplierInnCorrectionNote({
        mode: 'shadow',
        decision: 'corrected',
        raw: '1',
        inn: '7842224734',
        source: 'edo',
      }),
    ).toBeNull();
    expect(
      supplierInnCorrectionNote({
        mode: 'on',
        decision: 'unverified',
        raw: '770201001',
        inn: null,
      }),
    ).toBeNull();
    expect(
      supplierInnCorrectionNote({
        mode: 'on',
        decision: 'valid',
        raw: '7842224734',
        inn: '7842224734',
      }),
    ).toBeNull();
    expect(supplierInnCorrectionNote(null)).toBeNull();
    expect(supplierInnCorrectionNote(undefined)).toBeNull();
  });
});
