import { contextBridge, ipcRenderer } from 'electron';
import type { ProductivityApi } from '@shared/contracts';

const productivityApi: ProductivityApi = {
  ssh: {
    connect: (input) => ipcRenderer.invoke('ssh:connect', input),
    disconnect: (input) => ipcRenderer.invoke('ssh:disconnect', input),
    reviewHostKey: (input) => ipcRenderer.invoke('ssh:review-host-key', input),
    openTerminal: (input) => ipcRenderer.invoke('ssh:open-terminal', input),
    attachTerminal: (input) => ipcRenderer.invoke('ssh:attach-terminal', input),
    openLocalTerminal: (input) => ipcRenderer.invoke('ssh:open-local-terminal', input),
    writeTerminal: (input) => ipcRenderer.invoke('ssh:write-terminal', input),
    resizeTerminal: (input) => ipcRenderer.invoke('ssh:resize-terminal', input),
    closeTerminal: (input) => ipcRenderer.invoke('ssh:close-terminal', input),
    onHostKey: (listener) => subscribe('ssh:host-key', listener),
    onTerminalData: (listener) => subscribe('ssh:terminal-data', listener),
    onDisconnect: (listener) => subscribe('ssh:disconnected', listener),
  },
  sftp: {
    open: (input) => ipcRenderer.invoke('sftp:open', input),
    list: (input) => ipcRenderer.invoke('sftp:list', input),
    makeDirectory: (input) => ipcRenderer.invoke('sftp:mkdir', input),
    rename: (input) => ipcRenderer.invoke('sftp:rename', input),
    remove: (input) => ipcRenderer.invoke('sftp:remove', input),
    upload: (input) => ipcRenderer.invoke('sftp:upload', input),
    download: (input) => ipcRenderer.invoke('sftp:download', input),
    onTransferProgress: (listener) => subscribe('sftp:transfer-progress', listener),
  },
  files: {
    connect: (input) => ipcRenderer.invoke('files:connect', input),
    disconnect: (input) => ipcRenderer.invoke('files:disconnect', input),
    list: (input) => ipcRenderer.invoke('files:list', input),
    makeDirectory: (input) => ipcRenderer.invoke('files:mkdir', input),
    remove: (input) => ipcRenderer.invoke('files:remove', input),
    upload: (input) => ipcRenderer.invoke('files:upload', input),
    download: (input) => ipcRenderer.invoke('files:download', input),
    reviewHostKey: (input) => ipcRenderer.invoke('files:review-host-key', input),
    onHostKey: (listener) => subscribe('files:host-key', listener),
    onTransferProgress: (listener) => subscribe('files:transfer-progress', listener),
  },
  database: {
    connect: (input) => ipcRenderer.invoke('database:connect', input),
    close: (input) => ipcRenderer.invoke('database:close', input),
    cancel: (input) => ipcRenderer.invoke('database:cancel', input),
    listNamespaces: (input) => ipcRenderer.invoke('database:list-namespaces', input),
    listObjects: (input) => ipcRenderer.invoke('database:list-objects', input),
    runSql: (input) => ipcRenderer.invoke('database:run-sql', input),
    findDocuments: (input) => ipcRenderer.invoke('database:find-documents', input),
    scanKeys: (input) => ipcRenderer.invoke('database:scan-keys', input),
    executeRedis: (input) => ipcRenderer.invoke('database:execute-redis', input),
    getMemcachedStats: (input) => ipcRenderer.invoke('database:memcached-stats', input),
    getMemcachedValue: (input) => ipcRenderer.invoke('database:memcached-get', input),
    setMemcachedValue: (input) => ipcRenderer.invoke('database:memcached-set', input),
    deleteMemcachedValue: (input) => ipcRenderer.invoke('database:memcached-delete', input),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version', {}),
    getUpdateStatus: () => ipcRenderer.invoke('app:update-status', {}),
    checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates', {}),
    installUpdate: () => ipcRenderer.invoke('app:install-update', {}),
    onUpdateStatus: (listener) => subscribe('app:update-status-changed', listener),
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list', {}),
    save: (input) => ipcRenderer.invoke('profiles:save', input),
    remove: (id) => ipcRenderer.invoke('profiles:remove', { id }),
  },
  connectionDirectory: {
    get: () => ipcRenderer.invoke('connection-directory:get', {}),
    choose: () => ipcRenderer.invoke('connection-directory:choose', {}),
    set: (input) => ipcRenderer.invoke('connection-directory:set', input),
  },
  sshKeys: {
    list: () => ipcRenderer.invoke('ssh-keys:list', {}),
    import: (input) => ipcRenderer.invoke('ssh-keys:import', input),
    generate: (input) => ipcRenderer.invoke('ssh-keys:generate', input),
    rename: (input) => ipcRenderer.invoke('ssh-keys:rename', input),
    changePassphrase: (input) => ipcRenderer.invoke('ssh-keys:change-passphrase', input),
    remove: (input) => ipcRenderer.invoke('ssh-keys:remove', input),
    exportPublic: (input) => ipcRenderer.invoke('ssh-keys:export-public', input),
  },
};

contextBridge.exposeInMainWorld('productivityApi', productivityApi);


function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}


