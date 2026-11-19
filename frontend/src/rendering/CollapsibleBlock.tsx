import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon, IconButton, type IconName } from '../components/ui';
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
  const ctx = useContext(CollapseContext);
  const [localOverride, setLocalOverride] = useState<boolean | undefined>(
    undefined,
  );

  const [autoCollapsed, setAutoCollapsed] = useState(defaultCollapsed);
  const manual = ctx ? ctx.getManual(collapseKey) : localOverride;
  const collapsed = manual ?? (completion === undefined ? defaultCollapsed : autoCollapsed);

  const completed = useRef(completion !== 'pending');
  const card = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const setCollapsed = (next: boolean) => {
    if (ctx) {
      ctx.setManual(collapseKey, next);
    } else {
      setLocalOverride(next);
    }
  };

  useLayoutEffect(() => {
    if (!completion || completion === 'pending' || completed.current) return;
    completed.current = true;
    if (completion !== 'collapse' || manual !== undefined || collapsed) return;
    if (card.current?.contains(document.activeElement)) trigger.current?.focus();
    setAutoCollapsed(true);
  });

  const toggle = () => setCollapsed(!collapsed);

  return (
    <div ref={card} className={`block-card ${subtle ? 'block-card--subtle' : ''}`.trim()}>
      <div
        className={`block-card__head ${collapsed ? 'block-card__head--collapsed' : ''}`.trim()}
      >
        <button
          type="button"
          ref={trigger}
          className="block-card__toggle"
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
          {icon ? <Icon name={icon} size={14} /> : null}
          <span className="block-card__title">{title}</span>
        </button>
        <div className="block-card__actions">
          {actions}
          <IconButton
            size="sm"
            icon={collapsed ? 'chevronDown' : 'chevronUp'}
            label={collapsed ? '展开内容' : '折叠内容'}
            onClick={toggle}
          />
        </div>
      </div>
      {!collapsed ? children : null}
    </div>
  );
}
