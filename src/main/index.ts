import { app, BrowserWindow } from 'electron';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { createMainWindow } from './window.js';
import { registerHandlers, type ApplicationServices } from './ipc/register-handlers.js';
import { ProfileStore } from './storage/profile-store.js';
import { SecretStore } from './storage/secret-store.js';
import { DatabaseSessionManager } from './connectors/database-session-manager.js';
import { createConnectorRegistry } from './connectors/default-registry.js';
import { KnownHostsStore } from './ssh/known-hosts-store.js';
import { SshSessionManager } from './ssh/ssh-session-manager.js';
import { TerminalSessionManager } from './terminal/terminal-session-manager.js';
import { SftpSessionManager } from './sftp/sftp-session-manager.js';

const require = createRequire(import.meta.url);
if (require('electron-squirrel-startup')) app.quit();
app.setAppUserModelId('com.squirrel.UnifiedProductivity.UnifiedProductivity');

const explicitDataDirectory = process.env.UNIFIED_PRODUCTIVITY_DATA_DIR?.trim();
if (explicitDataDirectory) { const resolvedDataDirectory = resolve(explicitDataDirectory); mkdirSync(resolvedDataDirectory, { recursive: true }); app.setPath('userData', resolvedDataDirectory); }

let services: ApplicationServices | undefined;
let shutdownStarted = false;

function openMainWindow(): void {
  if (!services) return;
  const window = createMainWindow();
  registerHandlers(window, services);
}

app.whenReady().then(() => {
  const profiles = new ProfileStore();
  const secrets = new SecretStore();
  const knownHosts = new KnownHostsStore();
  const ssh = new SshSessionManager(profiles, secrets, knownHosts);
  const terminals = new TerminalSessionManager(ssh);
  const sftp = new SftpSessionManager(ssh);
  services = { profiles, secrets, databases: new DatabaseSessionManager(profiles, secrets, createConnectorRegistry()), ssh, terminals, sftp, knownHosts };
  openMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });

  app.on('before-quit', (event) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    event.preventDefault();
    void Promise.all([services?.databases.closeAll(), services?.ssh.closeAll(), services?.terminals.closeAll(), services?.sftp.closeAll()]).finally(() => app.quit());
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});





