import { app, autoUpdater, BrowserWindow, dialog } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { UpdateStatus } from '@shared/contracts';

const updateIntervalMs = 60 * 60 * 1000;
const firstCheckDelayMs = 15 * 1000;

export class UpdateManager {
  private status: UpdateStatus = { state: 'idle', message: 'Updates have not been checked yet.' };
  private window: BrowserWindow | undefined;
  private supported = false;
  private checkPending = false;
  private installStarted = false;
  private restartPromptOpen = false;

  initialize(): void {
    if (process.platform !== 'win32' || !app.isPackaged) {
      this.setStatus({ state: 'unsupported', message: 'Automatic updates are available in installed Windows builds.' });
      return;
    }
    const squirrelRoot = resolve(dirname(process.execPath), '..');
    if (!existsSync(join(squirrelRoot, 'Update.exe'))) {
      this.setStatus({ state: 'unsupported', message: 'Automatic updates are enabled for Setup.exe installations. MSI installations are updated by your administrator.' });
      return;
    }

    this.supported = true;
    autoUpdater.setFeedURL({ url: `https://update.electronjs.org/kawing11a/aetherexa/win32-x64/${app.getVersion()}` });
    autoUpdater.on('checking-for-update', () => {
      this.checkPending = true;
      this.setStatus({ state: 'checking', message: 'Checking GitHub Releases for an update…' });
    });
    autoUpdater.on('update-available', () => {
      this.checkPending = false;
      this.setStatus({ state: 'downloading', message: 'An update is available and is downloading in the background.' });
    });
    autoUpdater.on('update-not-available', () => {
      this.checkPending = false;
      this.setStatus({ state: 'current', message: 'Aetherexa is up to date.' });
    });
    autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
      this.checkPending = false;
      this.setStatus({ state: 'ready', message: `${releaseName || 'An update'} is ready. Restart Aetherexa to apply it.` });
      void this.promptForRestart();
    });
    autoUpdater.on('error', () => {
      this.checkPending = false;
      this.setStatus({ state: 'error', message: 'Aetherexa could not check or download an update. Check your connection and try again.' });
    });

    const startupCheck = setTimeout(() => this.checkNow(), firstCheckDelayMs);
    startupCheck.unref();
    const periodicCheck = setInterval(() => this.checkNow(), updateIntervalMs);
    periodicCheck.unref();
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
    this.sendStatus();
    window.once('closed', () => {
      if (this.window === window) this.window = undefined;
    });
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  checkNow(): UpdateStatus {
    if (!this.supported) return this.status;
    if (this.checkPending || this.status.state === 'downloading' || this.status.state === 'ready') return this.status;
    this.checkPending = true;
    this.setStatus({ state: 'checking', message: 'Checking GitHub Releases for an update…' });
    try {
      autoUpdater.checkForUpdates();
    } catch {
      this.checkPending = false;
      this.setStatus({ state: 'error', message: 'Aetherexa could not check for updates. Try again later.' });
    }
    return this.status;
  }

  install(): void {
    if (!this.supported || this.status.state !== 'ready' || this.installStarted) return;
    this.installStarted = true;
    autoUpdater.quitAndInstall();
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    this.sendStatus();
  }

  private sendStatus(): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('app:update-status-changed', this.status);
  }

  private async promptForRestart(): Promise<void> {
    if (this.restartPromptOpen) return;
    this.restartPromptOpen = true;
    try {
      const options = {
        type: 'info' as const,
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Aetherexa update ready',
        message: 'Aetherexa has downloaded an update.',
        detail: 'Restart the app now to install it, or continue working and restart later.',
      };
      const result = this.window && !this.window.isDestroyed()
        ? await dialog.showMessageBox(this.window, options)
        : await dialog.showMessageBox(options);
      if (result.response === 0) this.install();
    } finally {
      this.restartPromptOpen = false;
    }
  }
}
