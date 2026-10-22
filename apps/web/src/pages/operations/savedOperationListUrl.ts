type OperationType = 'delivery' | 'shipment';

function listParams(params: URLSearchParams, type: OperationType): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set('type', type);
  for (const key of ['delivery', 'shipment', 'new', 'upd', 'from']) next.delete(key);
  return next;
}

/** Close an editor and return to the same list tab, page and filters. */
export function closedOperationListUrl(params: URLSearchParams, type: OperationType): string {
  const next = listParams(params, type);
  // The legacy /kpp link used from=accepted without an explicit tab.
  if (!next.has('tab') && params.get('from') === 'accepted') next.set('tab', 'accepted');
  return `/operations?${next.toString()}`;
}

/** Close the editor after saving without losing the current accepted-list page or filters. */
export function savedOperationListUrl(params: URLSearchParams, type: OperationType): string {
  const next = listParams(params, type);
  // A page number from "Expected" belongs to a different list. Newly saved
  // operations open "Accepted" from its first page.
  if (next.get('tab') !== 'accepted') next.delete('page');
  next.set('tab', 'accepted');
  return `/operations?${next.toString()}`;
}
