import { createConnection } from 'node:net';

type SourceCall = { path: string; params: Record<string, string> };
type CommandResult = { ok: boolean; calls: SourceCall[]; error?: string };

// 测试进程私有 Unix socket；不会给生产 API 添加控制或采集 endpoint。
export async function command(socketPath: string, action: 'check' | 'execute-start' | 'release-failure' | 'retry' | 'calls'): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    socket.setTimeout(15_000, () => socket.destroy(new Error('Fixture command timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ action }) + '\n'));
    socket.on('data', chunk => { output += String(chunk); });
    socket.on('end', () => {
      try {
        const result: CommandResult = JSON.parse(output);
        if (!result.ok) throw new Error(result.error ?? 'Fixture command failed');
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}
