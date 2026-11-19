import { useSearchParams } from 'react-router-dom';
import { patchSearchParams } from '../utils/searchParams';

/**
 * Строковый параметр адреса как состояние страницы — для поиска в
 * справочниках и списке пользователей.
 *
 * В useState поиск пропадал при переключении вкладки справочников и при уходе
 * в другой раздел; в адресе его возвращает память списков (shared/listMemory).
 * Пустая строка снимает параметр. Новое значение снимает и номер страницы:
 * новый запрос — с первой страницы, иначе после сужения поиска человек
 * оставался бы на седьмой странице пустого результата.
 */
export function useUrlParam(key: string): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? '';
  const set = (next: string) => {
    if (next === value) return;
    setParams(patchSearchParams(params, { [key]: next || null, page: null }), { replace: true });
  };
  return [value, set];
}

/** Номер страницы в адресе (`?page=`); первая страница — без параметра. */
export function useUrlPage(): [number, (page: number) => void] {
  const [params, setParams] = useSearchParams();
  const raw = Number.parseInt(params.get('page') ?? '', 10);
  const page = Number.isFinite(raw) && raw > 1 ? raw : 1;
  const set = (next: number) => {
    if (next === page) return;
    setParams(patchSearchParams(params, { page: next > 1 ? String(next) : null }), {
      replace: true,
    });
  };
  return [page, set];
}
