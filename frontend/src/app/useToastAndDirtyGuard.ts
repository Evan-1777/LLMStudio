import { useCallback, useEffect, useRef, useState } from 'react';

export interface ToastState {
  message: string;
  tone: 'default' | 'error';
}

export function useToastAndDirtyGuard() {
  const [toastState, setToastState] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const dirtyGuardRef = useRef<(() => boolean) | null>(null);
  const [discardPromptResolver, setDiscardPromptResolver] = useState<
    ((allowed: boolean) => void) | null
  >(null);

  const toast = useCallback(
    (message: string, tone: 'default' | 'error' = 'default') => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      setToastState({ message, tone });
      toastTimerRef.current = window.setTimeout(() => {
        setToastState(null);
        toastTimerRef.current = null;
      }, 2800);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const registerDirtyGuard = useCallback((guard: (() => boolean) | null) => {
    dirtyGuardRef.current = guard;
  }, []);

  const confirmLeaveIfDirty = useCallback((): Promise<boolean> => {
    const guard = dirtyGuardRef.current;
    if (!guard || !guard()) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      setDiscardPromptResolver(() => resolve);
    });
  }, []);

  return {
    toastState,
    toast,
    discardPromptResolver,
    setDiscardPromptResolver,
    registerDirtyGuard,
    confirmLeaveIfDirty,
  };
}
