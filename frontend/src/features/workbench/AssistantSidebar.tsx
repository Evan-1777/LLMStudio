import { Link, useLocation } from 'react-router-dom';
import { Avatar, Icon, IconButton } from '../../components/ui';
import type { Assistant } from '../../core/types';

export function AssistantSidebar({
  assistants,
  activeAssistantId,
  onSelectAssistant,
  onAddAssistant,
  onEditAssistant,
  onNavigateSettings,
  drawerOpen,
}: {
  assistants: Assistant[];
  activeAssistantId: string;
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
          <img src="/favicon.png" alt="" className="wb-brand__mark" aria-hidden="true" />
          <span>LLMStudio</span>
        </div>
        <IconButton
          size="sm"
          icon="plus"
          label="添加助手"
          onClick={onAddAssistant}
        />
      </div>

      <div className="wb-rail__body">
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
                  <Avatar kind="assistant" src={assistant.avatarDataUrl} size={24} />
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
      </div>

      <div className="wb-rail__foot">
        <Link
          to="/settings/providers"
          state={{ from: fromPath }}
          className="ui-icon-btn"
          aria-label="设置"
          title="设置"
          onClick={onNavigateSettings}
        >
          <Icon name="settings" size={16} />
        </Link>
      </div>
    </aside>
  );
}
