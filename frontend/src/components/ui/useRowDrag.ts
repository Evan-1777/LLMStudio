import { useEffect, useEffectEvent, useRef, useState, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react';

const DRAG_DISTANCE = 6;
const LONG_PRESS_MS = 320;

type Point = { clientX: number; clientY: number };
type Session = {
  id: string;
  kind: 'pointer' | 'touch';
  key: number;
  start: Point;
  active: boolean;
  timer?: number;
};

// The list owns hit testing and persistence; this hook only recognizes a drag.
export function useRowDrag<T>(
  enabled: boolean,
  hitTest: (id: string, point: Point) => T | null,
  commit: (id: string, target: T) => void,
  scope?: string,
) {
  const session = useRef<Session | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<{ id: string; target: T | null } | null>(null);

  const update = useEffectEvent((id: string, point: Point) => {
    setDrag({ id, target: hitTest(id, point) });
  });
  const drop = useEffectEvent((id: string, point: Point) => {
    const target = hitTest(id, point);
    if (target !== null) commit(id, target);
  });

  useEffect(() => {
    const finish = (point?: Point) => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      window.clearTimeout(s.timer);
      if (s.active) {
        setDrag(null);
        if (point) drop(s.id, point);
      }
    };
    const move = (s: Session, point: Point, event: Event) => {
      if (!s.active) {
        if (Math.hypot(point.clientX - s.start.clientX, point.clientY - s.start.clientY) < DRAG_DISTANCE) return;
        if (s.kind === 'touch') { finish(); return; }
        s.active = true;
        suppressClick.current = true;
      }
      if (event.cancelable) event.preventDefault();
      update(s.id, point);
    };
    const pointer = (e: PointerEvent) => {
      const s = session.current;
      if (s?.kind !== 'pointer' || s.key !== e.pointerId) return;
      if (e.type === 'pointermove') move(s, e, e);
      else finish(e.type === 'pointerup' ? e : undefined);
    };
    const touch = (e: TouchEvent) => {
      const s = session.current;
      if (s?.kind !== 'touch') return;
      const point = Array.from(e.changedTouches).find(t => t.identifier === s.key);
      if (!point) return;
      if (e.type === 'touchmove') move(s, point, e);
      else {
        if (s.active && e.cancelable) e.preventDefault();
        finish(e.type === 'touchend' ? point : undefined);
      }
    };
    const cancel = () => finish();
    const additionalTouch = (e: TouchEvent) => {
      if (e.touches.length > 1) finish();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !session.current) return;
      if (session.current.active) e.preventDefault();
      finish();
    };
    const consumeClick = (e: MouseEvent) => {
      if (!suppressClick.current || e.detail === 0) return;
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    const freshPointer = () => { suppressClick.current = false; };
    const contextMenu = (e: MouseEvent) => {
      if (session.current?.active) e.preventDefault();
    };
    const events = new AbortController();
    const { signal } = events;
    // Keep click suppression until release even if the list becomes disabled mid-drag.
    window.addEventListener('click', consumeClick, { signal, capture: true });
    window.addEventListener('pointerdown', freshPointer, { signal, capture: true });
    if (enabled) {
      for (const type of ['pointermove', 'pointerup', 'pointercancel'] as const) {
        window.addEventListener(type, pointer, { signal, passive: false });
      }
      for (const type of ['touchmove', 'touchend', 'touchcancel'] as const) {
        window.addEventListener(type, touch, { signal, passive: false });
      }
      window.addEventListener('touchstart', additionalTouch, { signal, passive: true });
      window.addEventListener('keydown', escape, { signal });
      window.addEventListener('blur', cancel, { signal });
      window.addEventListener('contextmenu', contextMenu, { signal });
    }
    return () => { events.abort(); finish(); };
  }, [enabled, scope]);

  const bind = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || session.current || e.pointerType === 'touch' || !e.isPrimary || e.button !== 0) return;
      const { clientX, clientY } = e;
      session.current = { id, kind: 'pointer', key: e.pointerId, start: { clientX, clientY }, active: false };
    },
    onTouchStart: (e: ReactTouchEvent<HTMLElement>) => {
      if (!enabled || session.current || e.touches.length !== 1) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const s: Session = { id, kind: 'touch', key: t.identifier, start: t, active: false };
      session.current = s;
      s.timer = window.setTimeout(() => {
        s.active = true;
        suppressClick.current = true;
        setDrag({ id, target: null });
      }, LONG_PRESS_MS);
    },
  });
  return { drag, bind };
}
