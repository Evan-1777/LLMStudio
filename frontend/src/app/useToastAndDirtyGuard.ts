import { useCallback, useEffect, useRef, useState } from 'react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastState {
  message: string;
  tone: 'default' | 'error';
  action?: ToastAction;
}

export type ToastOptions =
  | 'default'
  | 'error'
  | {
      tone?: 'default' | 'error';
      action?: ToastAction;
    };

export function useToastAndDirtyGuard() {
  const [toastState, setToastState] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const dirtyGuardRef = useRef<(() => boolean) | null>(null);
  const [discardPromptResolver, setDiscardPromptResolver] = useState<
    ((allowed: boolean) => void) | null
  >(null);

  const toast = useCallback(
    (message: string, toneOrOptions: ToastOptions = 'default') => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      const tone =
        typeof toneOrOptions === 'string'
          ? toneOrOptions
          : (toneOrOptions.tone ?? 'default');
      const action =
        typeof toneOrOptions === 'string' ? undefined : toneOrOptions.action;
      setToastState({ message, tone, action });
      toastTimerRef.current = window.setTimeout(() => {
        setToastState(null);
        toastTimerRef.current = null;
      }, action ? 4500 : 2800);
    },
    [],
  );

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastState(null);
  }, []);

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
    dismissToast,
    discardPromptResolver,
    setDiscardPromptResolver,
    registerDirtyGuard,
    confirmLeaveIfDirty,
  };
}
