import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'kpp:expandedGroups:';

function load(deliveryId: string | null): string[] {
  if (!deliveryId || typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PREFIX + deliveryId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function save(deliveryId: string, keys: string[]): void {
  try {
    window.localStorage.setItem(PREFIX + deliveryId, JSON.stringify(keys));
  } catch {
    /* ignore quota */
  }
}

export function useExpandedGroups(deliveryId: string | null): {
  expanded: string[];
  setExpanded: (keys: string[]) => void;
  toggle: (key: string) => void;
} {
  const [expanded, setExpandedState] = useState<string[]>(() => load(deliveryId));

  useEffect(() => {
    setExpandedState(load(deliveryId));
  }, [deliveryId]);

  const setExpanded = useCallback(
    (keys: string[]) => {
      setExpandedState(keys);
      if (deliveryId) save(deliveryId, keys);
    },
    [deliveryId],
  );

  const toggle = useCallback(
    (key: string) => {
      setExpandedState((prev) => {
        const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
        if (deliveryId) save(deliveryId, next);
        return next;
      });
    },
    [deliveryId],
  );

  return { expanded, setExpanded, toggle };
}
