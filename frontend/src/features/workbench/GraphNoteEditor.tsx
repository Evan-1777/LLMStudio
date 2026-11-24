import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Point } from './conversationGraph';

export interface GraphNoteEditorProps {
  position: Point;
  text: string;
  onChange: (text: string) => void;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

export function GraphNoteEditor({
  position,
  text,
  onChange,
  onCommit,
  onCancel,
}: GraphNoteEditorProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, []);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(26, el.scrollHeight) + 'px';
  }, [text]);

  const finish = (mode: 'commit' | 'cancel') => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (mode === 'cancel') {
      onCancel();
      return;
    }
    const trimmed = text.trim();
    if (trimmed) onCommit(trimmed);
    else onCancel();
  };

  return (
    <div
      className="cg-node cg-node--note-editing"
      data-kind="note"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <textarea
        ref={inputRef}
        className="cg-note-editor__input"
        aria-label="文字标注"
        rows={1}
        maxLength={2000}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => finish('commit')}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            finish('cancel');
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            finish('commit');
          }
        }}
      />
    </div>
  );
}
