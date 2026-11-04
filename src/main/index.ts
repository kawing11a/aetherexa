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
import { ConnectionDirectoryStore } from './storage/connection-directory-store.js';
import { SshKeyStore } from './storage/ssh-key-store.js';
import { SshKeyManager } from './ssh/ssh-key-manager.js';
import { SftpProvider } from './files/sftp-provider.js';
import { FtpProvider } from './files/ftp-provider.js';
import { FileSessionManager } from './files/file-session-manager.js';
import { S3Provider } from './files/s3-provider.js';

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

app.whenReady().then(async () => {
  updates = new UpdateManager();
  updates.initialize();
  const connectionDirectory = new ConnectionDirectoryStore();
  await connectionDirectory.initialize();
  const profiles = new ProfileStore(connectionDirectory);
  const secrets = new SecretStore();
  const sshKeys = new SshKeyManager(new SshKeyStore(), secrets, profiles);
  const knownHosts = new KnownHostsStore();
  const ssh = new SshSessionManager(profiles, secrets, knownHosts, sshKeys);
  const terminals = new TerminalSessionManager(ssh);
  const sftp = new SftpSessionManager(ssh);
  const files = new FileSessionManager(profiles, secrets, new SftpProvider(sshKeys, knownHosts), new FtpProvider(), new S3Provider());
  services = { profiles, secrets, databases: new DatabaseSessionManager(profiles, secrets, createConnectorRegistry()), ssh, terminals, sftp, knownHosts, connectionDirectory, sshKeys, files };
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
      services?.files.closeAll(),
    ]).then(() => {
      sessionsClosed = true;
    });
  }
  return sessionClosePromise;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});





