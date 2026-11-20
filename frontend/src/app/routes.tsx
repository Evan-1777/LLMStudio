import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { isDesktopApp } from '../core/desktop';
import { SettingsLayout } from '../features/settings';
import { WorkbenchPage } from '../features/workbench/WorkbenchPage';

export const SETTINGS_SECTIONS = [
  'providers',
  'plugins',
  'connection',
  'appearance',
  'client',
  'mcp',
  'storage',
  'about',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return Boolean(
    value && (SETTINGS_SECTIONS as readonly string[]).includes(value),
  );
}

function SettingsRoute() {
  const { section } = useParams();
  if (!isSettingsSection(section) || (section === 'client' && !isDesktopApp())) {
    return <Navigate to="/settings/providers" replace />;
  }
  return <SettingsLayout />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/chat" replace />} />
      <Route path="/chat" element={<WorkbenchPage />} />
      <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
      <Route
        path="/settings"
        element={<Navigate to="/settings/providers" replace />}
      />
      <Route path="/settings/:section" element={<SettingsRoute />} />
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}
