import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0c1118',
    show: false,
    title: 'Unified Productivity',
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const rendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const localRenderer = pathToFileURL(join(currentDirectory, '../renderer/index.html')).href;
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (rendererUrl) {
      try { if (new URL(targetUrl).origin === new URL(rendererUrl).origin) return; } catch { /* Reject malformed navigation targets. */ }
    } else if (targetUrl === localRenderer) {
      return;
    }
    event.preventDefault();
  });

  if (rendererUrl) void window.loadURL(rendererUrl);
  else void window.loadFile(join(currentDirectory, '../renderer/index.html'));

  return window;
}
