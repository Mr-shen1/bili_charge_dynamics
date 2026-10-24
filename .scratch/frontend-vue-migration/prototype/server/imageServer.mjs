// 受控图片夹具服务器：只提供本原型自己的确定性图片，不访问任何真实来源或 OSS。
// 缩略图与预览使用不同路径，便于观察真实网络请求；另提供失败、缺失与可重试路径。
import { createServer } from 'node:http';

const port = Number(process.env.IMAGE_SERVER_PORT ?? 4319);
/** @type {{ path: string, status: number, at: number }[]} */
const requests = [];
/** @type {Map<string, number>} */
const flakyFailures = new Map();

const palette = ['#0f766e', '#b45309', '#1d4ed8', '#9d174d', '#4d7c0f', '#7e22ce'];

function escapeXml(value) {
  return value.replace(/[<>&"']/g, character => `&#${character.charCodeAt(0)};`);
}

function image({ width, height, label, tone }) {
  const stripe = Math.max(40, Math.round(height / 12));
  const bands = [];
  for (let y = 0, index = 0; y < height; y += stripe, index += 1) {
    bands.push(`<rect x="0" y="${y}" width="${width}" height="${stripe}" fill="${palette[index % palette.length]}" opacity="0.28"/>`);
  }
  const markerSize = Math.max(18, Math.round(Math.min(width, height) / 14));
  const marks = [];
  for (let y = markerSize; y < height; y += Math.max(120, markerSize * 4)) {
    marks.push(`<text x="16" y="${y}" font-size="${markerSize}" fill="#f8fafc">${escapeXml(label)} @${y}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="${tone}"/>
${bands.join('')}
${marks.join('')}
</svg>`;
}

function sendImage(response, spec) {
  const body = image(spec);
  response.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // no-store 让每次加载都真实落到服务器，网络证据不依赖缓存状态。
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function stripExtension(name) {
  return name.replace(/\.svg$/, '');
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/__requests') {
    sendJson(response, 200, { requests });
    return;
  }
  if (url.pathname === '/__reset') {
    requests.length = 0;
    flakyFailures.clear();
    sendJson(response, 200, { ok: true });
    return;
  }
  if (!url.pathname.startsWith('/images/')) {
    sendJson(response, 404, { error: 'not-found' });
    return;
  }

  const record = (status) => requests.push({ path: `${url.pathname}${url.search}`, status, at: Date.now() });
  const rest = url.pathname.slice('/images/'.length);
  const [kind, ...tail] = rest.split('/');
  const key = stripExtension(tail[tail.length - 1] ?? '');

  if (kind === 'thumb' && key) {
    record(200);
    sendImage(response, { width: 320, height: 200, label: `thumb ${key}`, tone: '#0f2f3f' });
    return;
  }
  if (kind === 'full' && key) {
    const longImage = key.startsWith('long');
    record(200);
    sendImage(response, longImage
      ? { width: 1200, height: 6000, label: `full ${key}`, tone: '#132b3a' }
      : { width: 1200, height: 675, label: `full ${key}`, tone: '#132b3a' });
    return;
  }
  if (kind === 'unavailable' && key) {
    // 未上传/无公开地址的占位：真实图片，但不是来源业务图。
    record(200);
    sendImage(response, { width: 800, height: 450, label: '图片未归档', tone: '#3f3f46' });
    return;
  }
  if (kind === 'invalid' && key) {
    record(404);
    sendJson(response, 404, { error: 'invalid-image-url' });
    return;
  }
  if (kind === 'broken' && key) {
    record(503);
    sendJson(response, 503, { error: 'image-unavailable' });
    return;
  }
  if (kind === 'flaky' && key) {
    const allowedFailures = Number(url.searchParams.get('failures') ?? 1);
    const failures = flakyFailures.get(key) ?? 0;
    if (failures < allowedFailures) {
      flakyFailures.set(key, failures + 1);
      record(503);
      sendJson(response, 503, { error: 'flaky-image', attempt: failures + 1 });
      return;
    }
    record(200);
    sendImage(response, { width: 1200, height: 675, label: `full ${key}`, tone: '#132b3a' });
    return;
  }

  record(404);
  sendJson(response, 404, { error: 'not-found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`image fixtures on http://127.0.0.1:${port}`);
});
