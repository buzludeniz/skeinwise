// The width of an element, kept up to date as it resizes. Charts draw to it.

import { useEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

export function useWidth(ref: RefObject<HTMLElement | null>, fallback = 800, min = 280): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, Math.floor(e!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return w;
}
