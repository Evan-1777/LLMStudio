import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from '../components/ui';
import './rendering.css';

type ManualCollapseMap = Map<string, boolean>;

const CollapseContext = createContext<{
  getManual: (key: string) => boolean | undefined;
  setManual: (key: string, collapsed: boolean) => void;
} | null>(null);

export function CollapseStateProvider({ children }: { children: ReactNode }) {
  const mapRef = useRef<ManualCollapseMap>(new Map());
  const [, setVersion] = useState(0);

  const getManual = useCallback(
    (key: string) => mapRef.current.get(key),
    [],
  );

  const setManual = useCallback((key: string, collapsed: boolean) => {
    mapRef.current.set(key, collapsed);
    setVersion((v) => v + 1);
  }, []);

  return (
    <CollapseContext.Provider value={{ getManual, setManual }}>
      {children}
    </CollapseContext.Provider>
  );
}

export function useCollapsibleState({
  collapseKey,
  defaultCollapsed,
  completion,
}: {
  collapseKey: string;
  defaultCollapsed: boolean;
  completion?: 'pending' | 'collapse' | 'keep';
}) {
  const ctx = useContext(CollapseContext);
  const [localOverride, setLocalOverride] = useState<boolean | undefined>(
    undefined,
  );

  const [autoCollapsed, setAutoCollapsed] = useState(defaultCollapsed);
  const manual = ctx ? ctx.getManual(collapseKey) : localOverride;
  const collapsed = manual ?? (completion === undefined ? defaultCollapsed : autoCollapsed);

  const completed = useRef(completion !== 'pending');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const setCollapsed = useCallback(
    (next: boolean) => {
      if (ctx) {
        ctx.setManual(collapseKey, next);
      } else {
        setLocalOverride(next);
      }
    },
    [collapseKey, ctx],
  );

  useLayoutEffect(() => {
    if (!completion || completion === 'pending' || completed.current) return;
    completed.current = true;
    if (completion !== 'collapse' || manual !== undefined || collapsed) return;
    if (containerRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus();
    }
    setAutoCollapsed(true);
  });

  const toggle = () => setCollapsed(!collapsed);

  return { collapsed, setCollapsed, toggle, containerRef, triggerRef };
}

export function CollapsibleBlock({
  collapseKey,
  title,
  icon,
  defaultCollapsed,
  completion,
  subtle = false,
  actions,
  children,
}: {
  collapseKey: string;
  title: string;
  icon?: IconName;
  defaultCollapsed: boolean;
  completion?: 'pending' | 'collapse' | 'keep';
  subtle?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { collapsed, toggle, containerRef, triggerRef } = useCollapsibleState({
    collapseKey,
    defaultCollapsed,
    completion,
  });

  return (
    <div ref={containerRef} className={`block-card ${subtle ? 'block-card--subtle' : ''}`.trim()}>
      <div
        className={`block-card__head ${collapsed ? 'block-card__head--collapsed' : ''}`.trim()}
      >
        <button
          type="button"
          ref={triggerRef}
          className="block-card__toggle"
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          <Icon name="chevronRight" size={14} className="block-card__chevron" />
          {icon ? <Icon name={icon} size={14} /> : null}
          <span className="block-card__title">{title}</span>
        </button>
        {actions ? <div className="block-card__actions">{actions}</div> : null}
      </div>
      {!collapsed ? children : null}
    </div>
  );
}
