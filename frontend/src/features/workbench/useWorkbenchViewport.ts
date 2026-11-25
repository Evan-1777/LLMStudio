import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  CHAT_WIDTH_MAX,
  CHAT_WIDTH_MIN,
  type AppPreferences,
} from '../../core/settings';
import type { ChatWidthMode } from '../../core/types';

export function useComposerViewport() {
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shell = shellRef.current;
    const viewport = window.visualViewport;
    if (!shell || !viewport) return;
    const handheld = window.matchMedia('(pointer: coarse)');
    let frame = 0;
    const clear = () => {
      shell.style.removeProperty('--wb-visible-height');
      shell.style.removeProperty('--wb-visible-top');
    };
    const update = () => {
      frame = 0;
      const focused = shell.querySelector('.wb-draft') === document.activeElement;
      if (!handheld.matches || !focused || viewport.scale !== 1 || viewport.height >= window.innerHeight - 1) {
        clear();
        return;
      }
      shell.style.setProperty('--wb-visible-height', viewport.height + 'px');
      shell.style.setProperty('--wb-visible-top', viewport.offsetTop + 'px');
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    shell.addEventListener('focusin', schedule, options);
    shell.addEventListener('focusout', schedule, options);
    viewport.addEventListener('resize', schedule, options);
    viewport.addEventListener('scroll', schedule, options);
    window.addEventListener('resize', schedule, options);
    handheld.addEventListener('change', schedule, options);
    schedule();
    return () => {
      listeners.abort();
      window.cancelAnimationFrame(frame);
      clear();
    };
  }, []);
  return shellRef;
}

export function useCompactViewport() {
  const [compact, setCompact] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 767px)').matches
      : false,
  );

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }
    const mql = window.matchMedia('(max-width: 767px)');
    const update = () => setCompact(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  return compact;
}

export function useChatManualWidth({
  chatWidthMode,
  chatManualWidth,
  updatePreferences,
}: {
  chatWidthMode: ChatWidthMode;
  chatManualWidth: number;
  updatePreferences: (
    patch: Partial<AppPreferences>,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const chatStageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [resizingWidth, setResizingWidth] = useState(false);
  const dragSessionRef = useRef<{
    pointerId: number;
    side: 'left' | 'right';
    startX: number;
    startWidth: number;
    containerWidth: number;
    currentWidth: number;
  } | null>(null);

  useEffect(() => {
    const el = chatStageRef.current;
    if (!el) return;
    const measure = () => setStageWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const manualWidthActive = chatWidthMode === 'manual';
  const resolvedManualWidth = useMemo(() => {
    if (!manualWidthActive) return null;
    const desired = dragWidth ?? chatManualWidth;
    if (stageWidth <= 0) {
      const clamped = Math.max(CHAT_WIDTH_MIN, Math.min(CHAT_WIDTH_MAX, desired));
      return { cssMaxWidth: `${Math.round(clamped)}px`, railHalfPx: Math.round(clamped) / 2, effectivePx: clamped };
    }
    const minAllowed = Math.min(CHAT_WIDTH_MIN, stageWidth);
    const maxAllowed = Math.min(CHAT_WIDTH_MAX, stageWidth);
    const clamped = Math.max(minAllowed, Math.min(maxAllowed, desired));
    if (stageWidth - clamped <= 8 && stageWidth <= CHAT_WIDTH_MAX) {
      return { cssMaxWidth: '100%', railHalfPx: stageWidth / 2, effectivePx: stageWidth };
    }
    return { cssMaxWidth: `${Math.round(clamped)}px`, railHalfPx: Math.round(clamped) / 2, effectivePx: clamped };
  }, [chatManualWidth, dragWidth, manualWidthActive, stageWidth]);

  const chatStageStyle = useMemo((): CSSProperties | undefined => {
    if (!resolvedManualWidth) return undefined;
    return {
      '--chat-max-width': resolvedManualWidth.cssMaxWidth,
      '--chat-rail-half': `${resolvedManualWidth.railHalfPx}px`,
    } as CSSProperties;
  }, [resolvedManualWidth]);

  const clampManualDragWidth = useCallback(
    (rawWidth: number, containerWidth: number): number => {
      const effMax = containerWidth > 0 ? Math.min(CHAT_WIDTH_MAX, containerWidth) : CHAT_WIDTH_MAX;
      const effMin = Math.min(CHAT_WIDTH_MIN, effMax);
      const clamped = Math.max(effMin, Math.min(effMax, rawWidth));
      if (containerWidth > 0 && containerWidth <= CHAT_WIDTH_MAX && containerWidth - clamped <= 8) {
        return containerWidth;
      }
      return Math.round(clamped);
    },
    [],
  );

  const handleWidthEdgePointerDown = (
    side: 'left' | 'right',
    e: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const containerWidth = chatStageRef.current?.clientWidth || stageWidth || chatManualWidth;
    const startWidth = resolvedManualWidth?.effectivePx ?? chatManualWidth;
    dragSessionRef.current = {
      pointerId: e.pointerId,
      side,
      startX: e.clientX,
      startWidth,
      containerWidth,
      currentWidth: startWidth,
    };
    setResizingWidth(true);
    setDragWidth(startWidth);
  };

  const handleWidthEdgePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    const dx = e.clientX - session.startX;
    const rawNext =
      session.side === 'right'
        ? session.startWidth + 2 * dx
        : session.startWidth - 2 * dx;
    const next = clampManualDragWidth(rawNext, session.containerWidth);
    session.currentWidth = next;
    setDragWidth(next);
  };

  const finishWidthDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    dragSessionRef.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setResizingWidth(false);
    setDragWidth(null);
    const committed = Math.max(
      CHAT_WIDTH_MIN,
      Math.min(CHAT_WIDTH_MAX, Math.round(session.currentWidth)),
    );
    if (committed !== chatManualWidth) {
      void updatePreferences({ chatManualWidth: committed });
    }
  };

  const handleWidthEdgeKeyDown = (
    side: 'left' | 'right',
    e: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const containerWidth = chatStageRef.current?.clientWidth || stageWidth || chatManualWidth;
    const base = resolvedManualWidth?.effectivePx ?? chatManualWidth;
    const delta =
      side === 'right'
        ? e.key === 'ArrowRight'
          ? 24
          : -24
        : e.key === 'ArrowLeft'
          ? 24
          : -24;
    const next = clampManualDragWidth(base + delta, containerWidth);
    const committed = Math.max(
      CHAT_WIDTH_MIN,
      Math.min(CHAT_WIDTH_MAX, Math.round(next)),
    );
    if (committed !== chatManualWidth) {
      void updatePreferences({ chatManualWidth: committed });
    }
  };

  return {
    chatStageRef,
    manualWidthActive,
    resizingWidth,
    chatStageStyle,
    handleWidthEdgePointerDown,
    handleWidthEdgePointerMove,
    finishWidthDrag,
    handleWidthEdgeKeyDown,
  };
}
