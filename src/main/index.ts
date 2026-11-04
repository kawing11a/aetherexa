import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
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
import { prepareAppDataDirectory } from './storage/app-data-migration.js';
import { UpdateManager } from './update/update-manager.js';

const require = createRequire(import.meta.url);
const squirrelStartupEvent = require('electron-squirrel-startup');
if (squirrelStartupEvent) app.quit();
app.setAppUserModelId('com.squirrel.aetherexa.Aetherexa');
if (!squirrelStartupEvent) prepareAppDataDirectory();

let services: ApplicationServices | undefined;
let updates: UpdateManager | undefined;
let sessionClosePromise: Promise<void> | undefined;
let sessionsClosed = false;

function openMainWindow(): void {
  if (!services || !updates) return;
  const window = createMainWindow();
  registerHandlers(window, services, updates);
}

app.whenReady().then(() => {
  updates = new UpdateManager();
  updates.initialize();
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
    if (sessionsClosed) return;
    event.preventDefault();
    void closeSessions().finally(() => app.quit());
  });
});

function closeSessions(): Promise<void> {
  if (!sessionClosePromise) {
    sessionClosePromise = Promise.all([
      services?.databases.closeAll(),
      services?.ssh.closeAll(),
      services?.terminals.closeAll(),
      services?.sftp.closeAll(),
    ]).then(() => {
      sessionsClosed = true;
    });
  }
  return sessionClosePromise;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});





