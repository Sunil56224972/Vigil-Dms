import React, { useEffect, useLayoutEffect, useRef } from 'react';
import anime from 'animejs';

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
}

interface SlidingSegmentedControlProps<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

export function SlidingSegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  ariaLabel,
}: SlidingSegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
  const initializedRef = useRef(false);

  const syncPill = (animate: boolean) => {
    const activeBtn = btnRefs.current.get(value);
    const pill = pillRef.current;
    const track = trackRef.current;
    if (!activeBtn || !pill || !track) return;

    const x = activeBtn.offsetLeft;
    const w = activeBtn.offsetWidth;

    anime.remove(pill);
    if (!animate || !initializedRef.current) {
      pill.style.transform = `translate3d(${x}px, 0, 0)`;
      pill.style.width = `${w}px`;
      pill.style.opacity = '1';
      initializedRef.current = true;
    } else {
      anime({
        targets: pill,
        translateX: x,
        width: w,
        easing: 'spring(1, 96, 14, 0)',
      });
    }
  };

  useLayoutEffect(() => {
    syncPill(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options.length]);

  useEffect(() => {
    const onResize = () => syncPill(false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const heightPx = size === 'sm' ? 27 : 28;
  const fontPx = size === 'sm' ? 11.5 : 12;

  return (
    <div
      ref={trackRef}
      role="tablist"
      aria-label={ariaLabel}
      className="sliding-seg-track"
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        padding: 2,
        background: 'var(--bg-well)',
        border: '1px solid var(--border-default)',
        borderRadius: 6,
        gap: 2,
        flexWrap: 'wrap',
      }}
    >
      <div
        ref={pillRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 2,
          left: 0,
          height: heightPx,
          borderRadius: 4,
          background: 'var(--ink-primary)',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.22)',
          pointerEvents: 'none',
          opacity: 0,
          willChange: 'transform, width',
          zIndex: 0,
        }}
      />
      {options.map((opt) => {
        const isActive = opt.id === value;
        return (
          <button
            key={opt.id}
            ref={(el) => {
              if (el) btnRefs.current.set(opt.id, el);
              else btnRefs.current.delete(opt.id);
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(opt.id)}
            style={{
              position: 'relative',
              zIndex: 1,
              height: heightPx,
              padding: size === 'sm' ? '0 10px' : '0 13px',
              border: 'none',
              background: 'transparent',
              fontFamily: 'var(--font-sans)',
              fontSize: fontPx,
              fontWeight: isActive ? 600 : 500,
              color: isActive ? 'var(--bg-surface)' : 'var(--ink-secondary)',
              cursor: 'pointer',
              borderRadius: 4,
              transition: 'color 0.14s ease',
              whiteSpace: 'nowrap',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
