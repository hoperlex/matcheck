/**
 * Черновик матрицы прав: состояние ячеек, каскад и дельта для сохранения.
 *
 * Вынесено из компонента отдельным модулем без React — здесь живут правила,
 * которые обязаны совпадать с серверными (routes/admin/role-permissions.ts).
 * Если они разойдутся, человек увидит одно, а сохранится другое: галочка
 * «отскочит» после ответа сервера или PATCH вернёт 400 на, казалось бы,
 * корректный клик.
 */
import {
  PAGE_ACTIONS,
  canExpand,
  isNeverGrantable,
  type ManagedRole,
  type PageAction,
  type PageId,
  type PagePermissions,
  type RolePermissionsResponse,
} from '@matcheck/contracts';

export type CatalogEntry = RolePermissionsResponse['catalog'][number];
export type Matrix = Record<ManagedRole, Record<PageId, PagePermissions>>;
export type Change = {
  role: ManagedRole;
  page: PageId;
  action: PageAction;
  allowed: boolean;
  /** Значение, которое видел клиент, — сервер сверит его с БД (409 при расхождении). */
  expected?: boolean;
};

/**
 * Что можно сделать с ячейкой:
 *   locked         — нужна мобильному КПП, снять нельзя ни здесь, ни в API;
 *   not-applicable — действия у страницы нет вовсе (у «Статистики» нет удаления);
 *   never          — право не выдаётся никому: через него можно получить
 *                    полномочия администратора («Роли», правка пользователей);
 *   write-locked   — роли можно выдать только «Просмотр»: на путях записи у неё
 *                    нет ограничения по своим данным;
 *   editable       — обычная галочка (в том числе выдача сверх базовых прав).
 */
export type CellState = 'locked' | 'not-applicable' | 'never' | 'write-locked' | 'editable';

export function cellKey(role: ManagedRole, page: PageId, action: PageAction): string {
  return `${role}:${page}:${action}`;
}

/** Есть ли право у роли ПО УМОЛЧАНИЮ — то есть без строки в матрице. */
export function baseAllows(entry: CatalogEntry, role: ManagedRole, action: PageAction): boolean {
  return entry.base[action]?.includes(role) ?? false;
}

export function cellState(
  entry: CatalogEntry,
  role: ManagedRole,
  action: PageAction,
  lockedCells: ReadonlySet<string>,
): CellState {
  if (lockedCells.has(cellKey(role, entry.id, action))) return 'locked';
  if (!entry.actions.includes(action)) return 'not-applicable';
  // Базовое право всегда редактируемо: его можно снять и вернуть обратно.
  // Ограничения ниже — про ВЫДАЧУ того, чего в дефолте не было.
  if (baseAllows(entry, role, action)) return 'editable';
  if (isNeverGrantable(entry.id, action)) return 'never';
  if (!canExpand(role, entry.id, action)) return 'write-locked';
  return 'editable';
}

/**
 * Ячейка выдаёт право СВЕРХ базового набора роли. Такие помечаем в интерфейсе:
 * администратор должен видеть, где он расширил доступ, а где просто оставил
 * как было.
 */
export function isExtension(
  entry: CatalogEntry,
  role: ManagedRole,
  action: PageAction,
  value: boolean,
): boolean {
  return value && !baseAllows(entry, role, action);
}

function clonePage(p: PagePermissions): PagePermissions {
  return { ...p };
}

/**
 * Переключить ячейку с каскадом.
 *
 * «Просмотр» — база: без него остальные действия бессмысленны (страницы не
 * видно), поэтому включение любого действия поднимает просмотр, а снятие
 * просмотра гасит остальные. Ровно этот же инвариант сервер применяет к
 * PATCH — иначе он вернул бы 400 view_required на то, что UI показал
 * допустимым.
 *
 * Заблокированные и неприменимые ячейки каскад не трогает.
 */
export function applyCell(
  draft: Matrix,
  entry: CatalogEntry,
  role: ManagedRole,
  action: PageAction,
  allowed: boolean,
  lockedCells: ReadonlySet<string>,
): Matrix {
  const page = entry.id;
  const current = draft[role]?.[page];
  if (!current) return draft;
  if (cellState(entry, role, action, lockedCells) !== 'editable') return draft;

  const next = clonePage(current);
  next[action] = allowed;

  if (allowed && action !== 'view') {
    // Включили действие — просмотр обязан быть включён. Если сам просмотр
    // выдать нельзя (never/write-locked), не трогаем: сервер такую пару всё
    // равно отклонит, и UI не должен обещать невозможное.
    if (cellState(entry, role, 'view', lockedCells) === 'editable') next.view = true;
  }
  if (!allowed && action === 'view') {
    for (const a of PAGE_ACTIONS) {
      if (a === 'view') continue;
      if (cellState(entry, role, a, lockedCells) !== 'editable') continue;
      next[a] = false;
    }
  }

  return { ...draft, [role]: { ...draft[role], [page]: next } };
}

/** Групповое переключение действия по всем страницам раздела. */
export function applyGroup(
  draft: Matrix,
  entries: CatalogEntry[],
  role: ManagedRole,
  action: PageAction,
  allowed: boolean,
  lockedCells: ReadonlySet<string>,
): Matrix {
  return entries.reduce(
    (acc, entry) => applyCell(acc, entry, role, action, allowed, lockedCells),
    draft,
  );
}

/**
 * Состояние группового чекбокса: все / ничего / частично. Учитываются только
 * ячейки, которые вообще можно включить, — иначе раздел с одной неприменимой
 * страницей навсегда застрял бы в «частично».
 */
export function groupState(
  draft: Matrix,
  entries: CatalogEntry[],
  role: ManagedRole,
  action: PageAction,
  lockedCells: ReadonlySet<string>,
): { checked: boolean; indeterminate: boolean; disabled: boolean } {
  const relevant = entries.filter(
    (e) => cellState(e, role, action, lockedCells) !== 'not-applicable',
  );
  if (relevant.length === 0) return { checked: false, indeterminate: false, disabled: true };

  const on = relevant.filter((e) => draft[role]?.[e.id]?.[action]).length;
  const editable = relevant.some(
    (e) => cellState(e, role, action, lockedCells) === 'editable',
  );
  return {
    checked: on === relevant.length,
    indeterminate: on > 0 && on < relevant.length,
    disabled: !editable,
  };
}

/**
 * Дельта «что менялось» — именно её принимает PATCH.
 *
 * Слать матрицу целиком нельзя: два администратора, правящих разные ячейки,
 * затирали бы правки друг друга. Дельта же конфликтует только на одной и той
 * же ячейке.
 *
 * `base` — снимок НА МОМЕНТ ПОДЪЁМА черновика, а не текущий ответ сервера.
 * Разница принципиальная: список сервера обновляется фоновым рефетчем, и если
 * считать дельту от него, чужая правка той же ячейки превратится в «моё»
 * изменение — возврат к прежнему значению, — и сохранение молча откатит чужую
 * работу. От неизменного снимка такая ячейка в дельту не попадает вовсе, а
 * если я её всё же трогал, `expected` даст серверу поймать конфликт (409).
 */
export function diffMatrix(base: Matrix, draft: Matrix): Change[] {
  const out: Change[] = [];
  for (const role of Object.keys(draft) as ManagedRole[]) {
    const pages = draft[role];
    if (!pages) continue;
    for (const page of Object.keys(pages) as PageId[]) {
      for (const action of PAGE_ACTIONS) {
        const before = base[role]?.[page]?.[action];
        const after = pages[page]?.[action];
        if (before === undefined || after === undefined) continue;
        if (before !== after) out.push({ role, page, action, allowed: after, expected: before });
      }
    }
  }
  return out;
}

/**
 * Перебазировать черновик на свежий ответ сервера.
 *
 * Ячейки, которые я не трогал, берём с сервера — иначе чужие правки не были бы
 * видны до перезагрузки страницы. Тронутые оставляем как есть: это моя
 * несохранённая работа, и терять её при фоновом рефетче нельзя. `base`
 * двигается вместе с нетронутыми ячейками, чтобы они не попали в дельту.
 */
export function rebaseDraft(
  base: Matrix,
  draft: Matrix,
  server: Matrix,
): { base: Matrix; draft: Matrix } {
  const touched = new Set(diffMatrix(base, draft).map((c) => cellKey(c.role, c.page, c.action)));
  const nextBase = cloneMatrix(server);
  const nextDraft = cloneMatrix(server);

  for (const role of Object.keys(draft) as ManagedRole[]) {
    for (const page of Object.keys(draft[role] ?? {}) as PageId[]) {
      for (const action of PAGE_ACTIONS) {
        if (!touched.has(cellKey(role, page, action))) continue;
        const mine = draft[role]?.[page]?.[action];
        const wasBase = base[role]?.[page]?.[action];
        if (mine === undefined || wasBase === undefined) continue;
        const target = nextDraft[role]?.[page];
        if (!target) continue;
        target[action] = mine;
        // База для тронутой ячейки остаётся прежней: именно это значение я
        // видел, и именно его сервер сверит с БД.
        const baseRow = nextBase[role]?.[page];
        if (baseRow) baseRow[action] = wasBase;
      }
    }
  }

  return { base: nextBase, draft: nextDraft };
}

/** Есть ли несохранённые правки у конкретной роли (точка рядом с её именем). */
export function roleHasChanges(server: Matrix, draft: Matrix, role: ManagedRole): boolean {
  return diffMatrix(server, draft).some((c) => c.role === role);
}

/** Глубокая копия матрицы: черновик правится независимо от ответа сервера. */
export function cloneMatrix(m: Matrix): Matrix {
  const out = {} as Matrix;
  for (const role of Object.keys(m) as ManagedRole[]) {
    const pages = m[role];
    if (!pages) continue;
    const copy = {} as Record<PageId, PagePermissions>;
    for (const page of Object.keys(pages) as PageId[]) {
      copy[page] = clonePage(pages[page]!);
    }
    out[role] = copy;
  }
  return out;
}
