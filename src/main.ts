import { createApp, type App as VueApp } from 'vue';
import '@fortawesome/fontawesome-free/css/all.min.css';
import './styles/index.css';
import WebAccessGate from './components/overlays/WebAccessGate.vue';
import { apiRequest, isTauri } from './utils/runtime';
import { hydrateBrowserStorage } from './utils/persistentStorage';

let gate: VueApp | undefined;
async function startApp() {
  try {
    await hydrateBrowserStorage();
    gate?.unmount();
    const { bootstrap } = await import('./appBootstrap');
    await bootstrap();
  } catch {
    showStartupError();
  }
}

function showStartupError() {
  gate?.unmount();
  const root = document.getElementById('app');
  if (!root) return;
  root.textContent = '连接服务或读取持久化数据失败，请检查服务后刷新重试。';
  root.style.cssText = 'display:grid;place-items:center;height:100%;padding:24px;color:var(--text-primary)';
}

async function start() {
  if (isTauri()) { await startApp(); return; }
  document.documentElement.dataset.runtime = 'web';
  try {
    const status = await apiRequest<{ configured: boolean; authenticated: boolean }>('/api/auth/status');
    if (status.authenticated) { await startApp(); return; }
    gate = createApp(WebAccessGate, { configured: status.configured, onReady: () => { void startApp(); } });
    gate.mount('#app');
  } catch { showStartupError(); }
}

window.addEventListener('coolapk-access-expired', () => location.reload());
void start();
