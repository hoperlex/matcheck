// Утилита для отображения времени этапа приёмки/отгрузки рядом с подписью
// «1 Этап (N)» / «2 Этап (N)». Логика по пользовательскому требованию:
// предпочитаем время фото машины/груза (то время, которое менеджер видит
// на самом фото-watermark внизу справа). Если фото машины нет — берём
// время последнего сделанного документа в этапе.

type PhotoLite = { takenAt: string; kind?: string };

/**
 * Возвращает «HH:MM» (или «HH:MM (ДД.ММ)», если фото снято не сегодня
 * относительно остальных кадров этапа). null — если фото в этапе нет
 * или ни у одного нет валидного takenAt.
 *
 * Выбор фото-«репрезентанта» этапа:
 *  1) последнее по takenAt среди kind ∈ {cargo, vehicle};
 *  2) иначе последнее среди kind='document';
 *  3) иначе последнее среди всех (фолбэк на случай неизвестного kind).
 */
export function formatStageTime(photos: PhotoLite[]): string | null {
  if (!photos.length) return null;

  const valid = photos.filter((p) => p.takenAt && !Number.isNaN(Date.parse(p.takenAt)));
  if (!valid.length) return null;

  const pickLatest = (arr: PhotoLite[]) =>
    arr.reduce((a, b) => (a.takenAt > b.takenAt ? a : b), arr[0]);

  const vehicleOrCargo = valid.filter((p) => p.kind === 'cargo' || p.kind === 'vehicle');
  const documents = valid.filter((p) => p.kind === 'document');
  const target =
    vehicleOrCargo.length > 0
      ? pickLatest(vehicleOrCargo)
      : documents.length > 0
        ? pickLatest(documents)
        : pickLatest(valid);

  return formatRu(target.takenAt);
}

function formatRu(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  // Дату не показываем — если этап пересекает сутки, это редкий случай
  // и читается из watermark на фото. Если потом понадобится — добавим
  // здесь ' (DD.MM)' условно.
  return `${hh}:${mm}`;
}
