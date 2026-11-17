import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './app/App';
import { retireLegacyFlutterServiceWorker } from './core/legacySwRetirement';

void retireLegacyFlutterServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
