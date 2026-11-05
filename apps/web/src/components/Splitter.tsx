import { useRef } from 'react';

/** Drag handle that resizes an adjacent panel. `sign` flips direction for panels on the right / bottom. */
export function Splitter({ axis, value, onChange, min, max, sign = 1 }: {
  axis: 'x' | 'y'; value: number; onChange: (v: number) => void; min: number; max: number; sign?: 1 | -1;
}) {
  const start = useRef<{ p: number; v: number } | null>(null);
  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { p: axis === 'x' ? e.clientX : e.clientY, v: value };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const d = (axis === 'x' ? e.clientX : e.clientY) - start.current.p;
        onChange(Math.min(max, Math.max(min, start.current.v + d * sign)));
      }}
      onPointerUp={() => { start.current = null; }}
      onDoubleClick={() => onChange(Math.min(max, Math.max(min, value)))}
    />
  );
}
