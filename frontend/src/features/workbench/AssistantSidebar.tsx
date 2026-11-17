import { Link, useLocation } from 'react-router-dom';
import { Icon, IconButton } from '../../components/ui';
import type { Assistant } from '../../core/types';

export function AssistantSidebar({
  assistants,
  activeAssistantId,
  connected,
  onSelectAssistant,
  onAddAssistant,
  onEditAssistant,
  onNavigateSettings,
  drawerOpen,
}: {
  assistants: Assistant[];
  activeAssistantId: string;
  connected: boolean;
  onSelectAssistant: (id: string) => void;
  onAddAssistant: () => void;
  onEditAssistant: (assistant: Assistant) => void;
  onNavigateSettings?: () => void;
  drawerOpen: boolean;
}) {
  const location = useLocation();
  const fromPath = `${location.pathname}${location.search}`;

  return (
    <aside
      className={`wb-rail ${drawerOpen ? 'wb-rail--drawer-open' : ''}`.trim()}
      aria-label="助手"
    >
      <div className="wb-rail__head">
        <div className="wb-brand">
          <span className="wb-brand__mark" aria-hidden="true">
            L
          </span>
          <span>LLMStudio</span>
        </div>
        <IconButton
          size="sm"
          icon="plus"
          label="添加助手"
          onClick={onAddAssistant}
        />
      </div>

      <div className="wb-section-bar">
        <span className="wb-eyebrow">助手</span>
      </div>

      <nav className="wb-list" aria-label="助手列表">
        {assistants.map((assistant) => {
          const active = assistant.id === activeAssistantId;
          return (
            <div
              key={assistant.id}
              className={`wb-nav-row ${active ? 'wb-nav-row--active' : ''}`.trim()}
            >
              <button
                type="button"
                className="wb-nav-row__btn"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelectAssistant(assistant.id)}
              >
                <Icon name="bot" size={16} />
                <span className="wb-nav-row__label">{assistant.name}</span>
              </button>
              <div className="wb-nav-row__actions">
                <IconButton
                  size="sm"
                  icon="edit"
                  label={`编辑 ${assistant.name}`}
                  onClick={() => onEditAssistant(assistant)}
                />
              </div>
            </div>
          );
        })}
      </nav>

      <div className="wb-rail__foot">
        <Link
          to="/settings/providers"
          state={{ from: fromPath }}
          className="wb-settings-link"
          onClick={onNavigateSettings}
        >
          <Icon name="settings" size={16} />
          <span>设置</span>
        </Link>
        <span
          className="wb-status-dot"
          title={connected ? '网关已连接' : '网关未连接'}
          aria-label={connected ? '网关已连接' : '网关未连接'}
        />
      </div>
    </aside>
  );
}
