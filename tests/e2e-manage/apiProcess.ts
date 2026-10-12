import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const apiLogs = new WeakMap<ChildProcess, () => string>();
export function logsOf(child: ChildProcess) { return apiLogs.get(child)?.() ?? ''; }

export async function stopApi(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const signal = (name: NodeJS.Signals) => {
    if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, name);
  };
  signal('SIGTERM');
  const forceStop = setTimeout(() => signal('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(forceStop); }
}

export async function startApi(database: string, options: {
  factory?: string; appDir?: string; env?: Record<string, string>;
} = {}) {
  const probe = createServer();
  probe.listen(4176, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const child = spawn('uv', ['run', '--no-sync', 'python', '-m', 'uvicorn',
    options.factory ?? 'backend.tests.live_app:create_app', '--factory',
    ...(options.appDir ? ['--app-dir', options.appDir] : []),
    '--host', '127.0.0.1', '--port', '4176'], {
    env: { ...process.env, ...options.env, BILI_DATABASE_PATH: database },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let startupError: Error | undefined;
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  child.on('error', error => { startupError = error; });
  apiLogs.set(child, () => output);
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Test API exited: ${output}`);
      try {
        const response = await fetch('http://127.0.0.1:4176/api/manage/ups', { signal: AbortSignal.timeout(500) });
        if (response.ok && Array.isArray((await response.json()).ups)) return child;
      } catch { /* 仅等待本测试启动的进程。 */ }
      await delay(100);
    }
    throw new Error(`Test API not ready: ${output}`);
  } catch (error) { await stopApi(child); throw error; }
  return child;
}
