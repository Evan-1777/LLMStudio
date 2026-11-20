import { BrowserRouter } from 'react-router-dom';
import '../styles/global.css';
import { AppProvider } from './AppProvider';
import { ConnectionGate } from './ConnectionGate';
import { AppRoutes } from './routes';

export function App({
  fetchImpl,
  skipInitialBootstrap = false,
}: {
  fetchImpl?: typeof fetch;
  skipInitialBootstrap?: boolean;
}) {
  return (
    <AppProvider
      fetchImpl={fetchImpl}
      skipInitialBootstrap={skipInitialBootstrap}
    >
      <BrowserRouter>
        <div className="app-frame">
          <div
            className="desktop-titlebar"
            data-testid="desktop-titlebar"
            aria-hidden="true"
          >
            <span className="desktop-titlebar__brand">LLMStudio</span>
          </div>
          <div className="app-frame__body">
            <ConnectionGate>
              <AppRoutes />
            </ConnectionGate>
          </div>
        </div>
      </BrowserRouter>
    </AppProvider>
  );
}
