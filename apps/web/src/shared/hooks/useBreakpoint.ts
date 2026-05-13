import { useEffect, useState } from 'react';

export type Breakpoint = 'mobile' | 'desktop';

function compute(width: number): Breakpoint {
  return width < 1024 ? 'mobile' : 'desktop';
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() =>
    typeof window === 'undefined' ? 'desktop' : compute(window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setBp(compute(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return bp;
}
