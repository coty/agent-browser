import * as net from 'net';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';
import { getSocketPath, isDaemonRunning, setSession, getSession } from './daemon.js';
import type { Response } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let DEBUG = false;

export function setDebug(enabled: boolean): void {
  DEBUG = enabled;
}

export { setSession, getSession };

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.error('[debug]', ...args);
  }
}

/**
 * Wait for socket to exist
 */
async function waitForSocket(maxAttempts = 30): Promise<boolean> {
  const socketPath = getSocketPath();
  debug('Waiting for socket at', socketPath);
  for (let i = 0; i < maxAttempts; i++) {
    if (fs.existsSync(socketPath)) {
      debug('Socket found after', i * 100, 'ms');
      return true;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  debug('Socket not found after', maxAttempts * 100, 'ms');
  return false;
}

/**
 * Ensure daemon is running, start if not
 */
export async function ensureDaemon(): Promise<void> {
  const session = getSession();
  debug(`Checking if daemon is running for session "${session}"...`);
  if (isDaemonRunning()) {
    debug('Daemon already running');
    return;
  }
  
  debug('Starting daemon...');
  const daemonPath = path.join(__dirname, 'daemon.js');
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, VEB_DAEMON: '1', VEB_SESSION: session },
  });
  child.unref();
  
  // Wait for socket to be created
  const ready = await waitForSocket();
  if (!ready) {
    throw new Error('Failed to start daemon');
  }
  
  debug(`Daemon started for session "${session}"`);
}

/**
 * Send a command to the daemon
 */
export async function sendCommand(command: Record<string, unknown>): Promise<Response> {
  const socketPath = getSocketPath();
  debug('Sending command:', JSON.stringify(command));
  
  return new Promise((resolve, reject) => {
    let resolved = false;
    let buffer = '';
    const startTime = Date.now();
    
    const socket = net.createConnection(socketPath);
    
    socket.on('connect', () => {
      debug('Connected to daemon, sending command...');
      socket.write(JSON.stringify(command) + '\n');
    });
    
    socket.on('data', (data) => {
      buffer += data.toString();
      debug('Received data:', buffer.length, 'bytes');
      
      // Try to parse complete JSON from buffer
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const jsonStr = buffer.substring(0, newlineIdx);
        try {
          const response = JSON.parse(jsonStr) as Response;
          debug('Response received in', Date.now() - startTime, 'ms');
          resolved = true;
          socket.end();
          resolve(response);
        } catch (e) {
          debug('JSON parse error:', e);
        }
      }
    });
    
    socket.on('error', (err) => {
      debug('Socket error:', err.message);
      if (!resolved) {
        reject(new Error(`Connection error: ${err.message}`));
      }
    });
    
    socket.on('close', () => {
      debug('Socket closed, resolved:', resolved, 'buffer:', buffer.length);
      if (!resolved && buffer.trim()) {
        try {
          const response = JSON.parse(buffer.trim()) as Response;
          resolve(response);
        } catch {
          reject(new Error('Invalid response from daemon'));
        }
      } else if (!resolved) {
        reject(new Error('Connection closed without response'));
      }
    });
    
    // Timeout after 15 seconds (allows for 10s Playwright timeout + overhead)
    setTimeout(() => {
      if (!resolved) {
        debug('Command timeout after 15s');
        socket.destroy();
        reject(new Error('Command timeout'));
      }
    }, 15000);
  });
}

/**
 * Send a command, ensuring daemon is running first
 */
export async function send(command: Record<string, unknown>): Promise<Response> {
  const startTime = Date.now();
  await ensureDaemon();
  debug('ensureDaemon took', Date.now() - startTime, 'ms');
  return sendCommand(command);
}
