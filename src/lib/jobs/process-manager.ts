import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger';

const logger = createLogger('process-manager');

const PID_FILE = path.resolve(process.cwd(), '.worker.pid');
const LOG_BUFFER_SIZE = 200; // keep last N lines

let workerProcess: ChildProcess | null = null;
let logLines: string[] = [];

/** Check if a PID is alive */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/** Read PID from file */
function readPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Write PID to file */
function writePid(pid: number) {
  writeFileSync(PID_FILE, String(pid), 'utf-8');
}

/** Remove PID file */
function clearPid() {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch { /* ignore */ }
}

/** Get the current worker status */
export function getWorkerProcessStatus(): { running: boolean; pid: number | null } {
  // Check in-memory reference first
  if (workerProcess && !workerProcess.killed && workerProcess.pid) {
    if (isRunning(workerProcess.pid)) {
      return { running: true, pid: workerProcess.pid };
    }
    workerProcess = null;
  }

  // Fall back to PID file (for processes started before this server instance)
  const pid = readPid();
  if (pid && isRunning(pid)) {
    return { running: true, pid };
  }

  clearPid();
  return { running: false, pid: null };
}

/** Start the worker process */
export function startWorkerProcess(): { success: boolean; message: string; pid?: number } {
  const status = getWorkerProcessStatus();
  if (status.running) {
    return { success: false, message: `Workers already running (PID ${status.pid})`, pid: status.pid! };
  }

  const cwd = process.cwd();
  const npxPath = 'npx';

  try {
    const child = spawn(npxPath, ['tsx', 'workers/entry.ts'], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    if (!child.pid) {
      return { success: false, message: 'Failed to spawn worker process' };
    }

    workerProcess = child;
    writePid(child.pid);
    logLines = [];

    // Capture stdout
    child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      logLines.push(...lines);
      if (logLines.length > LOG_BUFFER_SIZE) {
        logLines = logLines.slice(-LOG_BUFFER_SIZE);
      }
    });

    // Capture stderr
    child.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      logLines.push(...lines.map((l) => `[stderr] ${l}`));
      if (logLines.length > LOG_BUFFER_SIZE) {
        logLines = logLines.slice(-LOG_BUFFER_SIZE);
      }
    });

    // Handle exit
    child.on('exit', (code, signal) => {
      logger.info({ pid: child.pid, code, signal }, 'Worker process exited');
      workerProcess = null;
      clearPid();
    });

    // Unref so the web server can exit independently
    child.unref();

    logger.info({ pid: child.pid }, 'Worker process started');
    return { success: true, message: `Workers started (PID ${child.pid})`, pid: child.pid };
  } catch (e: any) {
    logger.error({ error: e.message }, 'Failed to start worker process');
    return { success: false, message: e.message };
  }
}

/** Stop the worker process */
export function stopWorkerProcess(): { success: boolean; message: string } {
  const status = getWorkerProcessStatus();
  if (!status.running || !status.pid) {
    return { success: false, message: 'Workers not running' };
  }

  try {
    process.kill(status.pid, 'SIGTERM');
    workerProcess = null;
    clearPid();
    logger.info({ pid: status.pid }, 'Worker process stopped');
    return { success: true, message: `Workers stopped (PID ${status.pid})` };
  } catch (e: any) {
    logger.error({ pid: status.pid, error: e.message }, 'Failed to stop worker process');
    return { success: false, message: e.message };
  }
}

/** Restart the worker process */
export async function restartWorkerProcess(): Promise<{ success: boolean; message: string; pid?: number }> {
  const status = getWorkerProcessStatus();
  if (status.running) {
    stopWorkerProcess();
  }

  // Wait for the old process to release ports/resources
  await new Promise((resolve) => setTimeout(resolve, 500));
  return startWorkerProcess();
}

/** Get recent log output */
export function getWorkerLogs(): string[] {
  return [...logLines];
}
