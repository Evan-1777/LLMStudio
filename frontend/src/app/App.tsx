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
        <ConnectionGate>
          <AppRoutes />
        </ConnectionGate>
      </BrowserRouter>
    </AppProvider>
  );
}
