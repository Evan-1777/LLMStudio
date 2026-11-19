import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { useApp, type ConnectionState } from '../../app/AppProvider';
import {
  isSettingsSection,
  type SettingsSection,
} from '../../app/routes';
import { Icon, IconButton, type IconName } from '../../components/ui';
import { AboutPage } from './AboutPage';
import { AppearancePage } from './AppearancePage';
import { ConnectionPage } from './ConnectionPage';
import { McpPage } from './McpPage';
import { PluginsPage } from './PluginsPage';
import { ProvidersPage } from './ProvidersPage';
import { StoragePage } from './StoragePage';
import './settings.css';

interface SettingsNavItem {
  id: SettingsSection;
  label: string;
  icon: IconName;
}

const NAV_ITEMS: readonly SettingsNavItem[] = [
  { id: 'providers', label: '模型服务', icon: 'cpu' },
  { id: 'plugins', label: '插件', icon: 'plugin' },
  { id: 'connection', label: '连接', icon: 'link' },
  { id: 'appearance', label: '外观与显示', icon: 'sun' },
  { id: 'mcp', label: 'MCP 配置', icon: 'wrench' },
  { id: 'storage', label: '存储', icon: 'folder' },
  { id: 'about', label: '关于', icon: 'info' },
];

function statusLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return '网关已连接';
    case 'checking':
      return '正在连接';
    case 'auth-required':
      return '需要令牌';
    case 'error':
      return '连接失败';
  }
}

function renderSectionContent(section: SettingsSection): ReactNode {
  switch (section) {
    case 'providers':
      return <ProvidersPage />;
    case 'plugins':
      return <PluginsPage />;
    case 'connection':
      return <ConnectionPage />;
    case 'appearance':
      return <AppearancePage />;
    case 'mcp':
      return <McpPage />;
    case 'storage':
      return <StoragePage />;
    case 'about':
      return <AboutPage />;
  }
}

export interface SettingsLayoutProps {
  section?: SettingsSection;
  onSelectSection?: (section: SettingsSection) => void;
  onBack?: () => void;
  children?: ReactNode;
}

export function SettingsLayout({
  section: propSection,
  onSelectSection,
  onBack,
  children,
}: SettingsLayoutProps) {
  const { section: routeSection } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { connectionState, confirmLeaveIfDirty } = useApp();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerToggleRef = useRef<HTMLButtonElement | null>(null);

  const closeDrawer = useCallback((restoreFocus = false) => {
    setDrawerOpen(false);
    if (restoreFocus) {
      queueMicrotask(() => drawerToggleRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeDrawer(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDrawer, drawerOpen]);

  if (!propSection && !isSettingsSection(routeSection)) {
    return <Navigate to="/settings/providers" replace />;
  }

  const activeSection: SettingsSection =
    propSection ?? (routeSection as SettingsSection);
  const activeItem =
    NAV_ITEMS.find((item) => item.id === activeSection) ?? NAV_ITEMS[0];

  const handleBack = async () => {
    if (!(await confirmLeaveIfDirty())) return;
    setDrawerOpen(false);
    if (onBack) {
      onBack();
      return;
    }
    const fromState = (location.state as { from?: string } | null)?.from;
    const target =
      typeof fromState === 'string' && fromState.startsWith('/chat')
        ? fromState
        : '/chat';
    navigate(target);
  };

  const handleSelectSection = async (next: SettingsSection) => {
    if (next === activeSection) {
      setDrawerOpen(false);
      return;
    }
    if (!(await confirmLeaveIfDirty())) return;
    setDrawerOpen(false);
    if (onSelectSection) {
      onSelectSection(next);
      return;
    }
    navigate(`/settings/${next}`, { state: location.state });
  };

  const dotClass =
    connectionState === 'connected'
      ? ''
      : connectionState === 'error'
        ? 'st-status-dot--error'
        : 'st-status-dot--warn';

  return (
    <div className="st-shell">
      <aside
        className={`st-rail ${drawerOpen ? 'st-rail--open' : ''}`.trim()}
        aria-label="设置分类"
      >
        <div className="st-rail__head">
          <div className="st-brand">
            <img src="/favicon.png" alt="" className="st-brand__mark" aria-hidden="true" />
            <span>设置</span>
          </div>
          <IconButton
            icon="arrowLeft"
            size="sm"
            label="返回工作台"
            onClick={() => void handleBack()}
          />
        </div>

        <div className="st-rail__body">
          <nav className="st-nav" aria-label="设置导航">
            {NAV_ITEMS.map((item) => {
              const active = item.id === activeSection;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`st-nav-item ${
                    active ? 'st-nav-item--active' : ''
                  }`.trim()}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => void handleSelectSection(item.id)}
                >
                  <Icon name={item.icon} size={16} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="st-rail-foot">
          <span className={`st-status-dot ${dotClass}`.trim()} aria-hidden="true" />
          <span>{statusLabel(connectionState)}</span>
        </div>
      </aside>

      <div className="st-main">
        <header className="st-toolbar">
          <IconButton
            ref={drawerToggleRef}
            icon="sidebar"
            label="打开设置分类"
            className="st-mobile-only"
            onClick={() => setDrawerOpen((v) => !v)}
          />
          <h1 className="st-toolbar__title">{activeItem.label}</h1>
          <div className="st-toolbar__spacer" />
          <IconButton
            icon="close"
            label="关闭设置"
            className="st-mobile-only"
            onClick={() => void handleBack()}
          />
        </header>

        {children ?? renderSectionContent(activeSection)}
      </div>

      <button
        type="button"
        className={`st-scrim ${drawerOpen ? 'st-scrim--open' : ''}`.trim()}
        aria-label="关闭设置导航"
        aria-hidden={!drawerOpen || undefined}
        tabIndex={drawerOpen ? 0 : -1}
        onClick={() => closeDrawer(true)}
      />
    </div>
  );
}

export const SettingsPage = SettingsLayout;
