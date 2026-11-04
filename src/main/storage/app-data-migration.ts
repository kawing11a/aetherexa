import { app } from 'electron';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const legacyDataDirectoryName = 'Unified Productivity';
const appDataDirectoryName = 'Aetherexa';

export function prepareAppDataDirectory(): void {
  const explicitDirectory = process.env.UNIFIED_PRODUCTIVITY_DATA_DIR?.trim();
  if (explicitDirectory) {
    const resolvedDirectory = resolve(explicitDirectory);
    mkdirSync(resolvedDirectory, { recursive: true });
    app.setPath('userData', resolvedDirectory);
    return;
  }

  const appDataDirectory = app.getPath('appData');
  const legacyDirectory = join(appDataDirectory, legacyDataDirectoryName);
  const newDirectory = join(appDataDirectory, appDataDirectoryName);
  if (existsSync(newDirectory)) {
    app.setPath('userData', newDirectory);
    return;
  }

  if (existsSync(legacyDirectory)) {
    try {
      mkdirSync(dirname(newDirectory), { recursive: true });
      renameSync(legacyDirectory, newDirectory);
    } catch {
      console.warn('Aetherexa could not move existing local data; continuing to use its previous data directory.');
      app.setPath('userData', legacyDirectory);
      return;
    }
  }

  app.setPath('userData', newDirectory);
}
