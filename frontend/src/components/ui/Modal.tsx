import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';
import { IconButton } from './Icon';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  wide?: boolean;
  busy?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  description?: string;
}

export function Modal({
  open,
  onOpenChange,
  title,
  wide = false,
  busy = false,
  children,
  footer,
  description,
}: ModalProps) {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    wasOpenRef.current = open;
  }, [open]);

  // Fallback if caller unmounts the Modal itself while still open.
  useEffect(() => {
    return () => {
      if (!wasOpenRef.current) return;
      const target = previousFocusRef.current;
      previousFocusRef.current = null;
      if (target && target.isConnected) {
        queueMicrotask(() => {
          if (document.activeElement === document.body || !document.activeElement) {
            target.focus({ preventScroll: true });
          }
        });
      }
    };
  }, []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy || next) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ui-dialog-overlay" />
        <Dialog.Content
          className={`ui-dialog-content ${wide ? 'ui-dialog-content--wide' : ''}`.trim()}
          aria-busy={busy || undefined}
          aria-describedby={description ? undefined : undefined}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            const target = previousFocusRef.current;
            previousFocusRef.current = null;
            if (target && target.isConnected) {
              e.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
        >
          <div className="ui-dialog-head">
            <Dialog.Title className="ui-dialog-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton
                icon="close"
                label="关闭"
                size="sm"
                disabled={busy}
              />
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description className="sr-only">
              {description}
            </Dialog.Description>
          ) : null}
          <div className="ui-dialog-body">{children}</div>
          {footer ? <div className="ui-dialog-foot">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = true,
  busy = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      busy={busy}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={title}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={() => {
              void onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </Modal>
  );
}
