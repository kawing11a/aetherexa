import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node-pty';
import type { WebContents } from 'electron';
import type { TerminalDescriptor, TerminalData } from '@shared/database';
import type { Result } from '@shared/contracts';
import type { SshSessionManager } from '../ssh/ssh-session-manager.js';

type TerminalSession = { ownerId: number; sshSessionId: string | null; close(): void; write(data: string): void; resize(cols: number, rows: number): void; attached: boolean; buffered: string[]; bufferedBytes: number; webContents: WebContents };
export class TerminalSessionManager {
  private readonly terminals = new Map<string, TerminalSession>();
  constructor(private readonly ssh: SshSessionManager) {}

  async openSsh(ownerId: number, sessionId: string, cols: number, rows: number, webContents: WebContents): Promise<Result<TerminalDescriptor>> {
    const client = this.ssh.getClient(ownerId, sessionId); if (!client.ok) return client;
    return new Promise((resolve) => client.value.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => {
      if (error) { resolve(failure('terminal-open-failed', 'The SSH terminal could not be opened.')); return; }
      const terminalId = randomUUID();
      const session: TerminalSession = { ownerId, sshSessionId: sessionId, close() { channel.close(); }, write(data) { channel.write(data); }, resize(nextCols, nextRows) { channel.setWindow(nextRows, nextCols, 0, 0); }, attached: false, buffered: [], bufferedBytes: 0, webContents };
      this.attach(terminalId, session, (listener) => channel.on('data', listener));
      client.value.once('close', () => { this.terminals.delete(terminalId); channel.close(); });
      channel.once('close', () => this.terminals.delete(terminalId));
      resolve({ ok: true, value: { terminalId, sessionId, local: false } });
    }));
  }
  openLocal(ownerId: number, cols: number, rows: number, webContents: WebContents): Result<TerminalDescriptor> {
    try {
      const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const terminal = spawn(shell, ['-NoLogo'], { name: 'xterm-256color', cols, rows, cwd: homedir(), env: process.env as Record<string, string> });
      const terminalId = randomUUID(); const sessionId = randomUUID();
      const session: TerminalSession = { ownerId, sshSessionId: null, close() { terminal.kill(); }, write(data) { terminal.write(data); }, resize(nextCols, nextRows) { terminal.resize(nextCols, nextRows); }, attached: false, buffered: [], bufferedBytes: 0, webContents };
      this.attach(terminalId, session, (listener) => terminal.onData(listener));
      terminal.onExit(() => this.terminals.delete(terminalId));
      return { ok: true, value: { terminalId, sessionId, local: true } };
    } catch { return failure('terminal-open-failed', 'The local PowerShell terminal could not be started.'); }
  }
  attachRenderer(ownerId: number, terminalId: string): Result<void> {
    const found = this.owned(ownerId, terminalId); if (!found.ok) return found;
    const session = found.value; session.attached = true;
    for (const data of session.buffered) this.send(session, terminalId, data);
    session.buffered = []; session.bufferedBytes = 0;
    return { ok: true, value: undefined };
  }
  write(ownerId: number, terminalId: string, data: string): Result<void> { const found = this.owned(ownerId, terminalId); if (!found.ok) return found; found.value.write(data); return { ok: true, value: undefined }; }
  resize(ownerId: number, terminalId: string, cols: number, rows: number): Result<void> { const found = this.owned(ownerId, terminalId); if (!found.ok) return found; found.value.resize(cols, rows); return { ok: true, value: undefined }; }
  close(ownerId: number, terminalId: string): Result<void> { const found = this.owned(ownerId, terminalId); if (!found.ok) return found; this.terminals.delete(terminalId); found.value.close(); return { ok: true, value: undefined }; }
  closeForSsh(ownerId: number, sessionId: string): void { for (const [id, item] of this.terminals) if (item.ownerId === ownerId && item.sshSessionId === sessionId) { this.terminals.delete(id); item.close(); } }
  closeProfile(profileId: string): void { for (const [id, item] of this.terminals) if (item.sshSessionId && this.ssh.getProfileId(item.sshSessionId) === profileId) { this.terminals.delete(id); item.close(); } }
  closeOwner(ownerId: number): void { for (const [id, item] of this.terminals) if (item.ownerId === ownerId) { this.terminals.delete(id); item.close(); } }
  closeAll(): void { for (const item of this.terminals.values()) item.close(); this.terminals.clear(); }

  private owned(ownerId: number, id: string): Result<TerminalSession> { const item = this.terminals.get(id); return item && item.ownerId === ownerId ? { ok: true, value: item } : failure('terminal-not-found', 'The terminal session is closed or unavailable.'); }
  private attach(id: string, session: TerminalSession, subscribe: (listener: (data: string) => void) => void): void {
    this.terminals.set(id, session);
    subscribe((data) => {
      for (let offset = 0; offset < data.length; offset += 64 * 1024) {
        const chunk = data.slice(offset, offset + 64 * 1024);
        if (session.attached) this.send(session, id, chunk);
        else if (session.bufferedBytes + chunk.length <= 1024 * 1024) { session.buffered.push(chunk); session.bufferedBytes += chunk.length; }
      }
    });
  }
  private send(session: TerminalSession, terminalId: string, data: string): void {
    if (session.webContents.isDestroyed()) return;
    const event: TerminalData = { terminalId, data };
    session.webContents.send('ssh:terminal-data', event);
  }
}
function failure<T = never>(code: string, message: string): Result<T> { return { ok: false, error: { code, message, retryable: false } }; }

