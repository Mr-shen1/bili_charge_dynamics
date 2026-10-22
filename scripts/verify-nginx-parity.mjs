#!/usr/bin/env node
// 校验阿里云部署配置与隔离验证基准不漂移。
//
// 背景：deploy/nginx.conf 是 scripts/verify-static-delivery.mjs 的隔离验证基准，
// 新增的部署配置把同一套规则抽到了 deploy/nginx-locations.conf 供两份 server
// 配置 include。规则一旦分叉，就会出现「隔离测试通过、生产规则不同」的盲区。
//
// 本脚本做三类检查，不需要 nginx 二进制：
//   1. deploy/nginx.conf 与 deploy/nginx-locations.conf 的 server 级指令和
//      location 块逐块一致。
//   2. 两份阿里云 server 配置都 include 了片段，且用的是同一个绝对路径。
//   3. 片段声明的安装路径与两份配置里的 include 路径一致。
//
// 用法：node scripts/verify-nginx-parity.mjs
//       pnpm test:nginx-parity

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (name) => readFile(join(repo, 'deploy', name), 'utf8');

const FRAGMENT_PATH = '/etc/nginx/snippets/bili-locations.conf';

// server 级、本应在基准与片段之间保持一致的指令。
const SERVER_DIRECTIVES = /^(root|index|etag|error_page)\s/;

/**
 * 提取顶层的 location 块（含嵌套块）与指定前缀的指令行。
 * 只处理二空格/四空格缩进的配置文件，够用于本项目的手写配置。
 */
function parse(text) {
  const lines = text.split('\n');
  const locations = new Map();
  const directives = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (SERVER_DIRECTIVES.test(line)) {
      directives.push(line.replace(/\s+/g, ' '));
      continue;
    }

    const header = line.match(/^(location\s+[^{]+?)\s*\{\s*$/);
    if (!header) continue;

    const name = header[1].replace(/\s+/g, ' ');
    const body = [];
    let depth = 1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const inner = lines[j];
      depth += (inner.match(/\{/g) || []).length;
      depth -= (inner.match(/\}/g) || []).length;
      if (depth <= 0) break;
      const trimmed = inner.trim();
      if (trimmed && !trimmed.startsWith('#')) body.push(trimmed.replace(/\s+/g, ' '));
    }
    assert(!locations.has(name), `重复的 location: ${name}`);
    locations.set(name, body.join('\n'));
  }

  return { directives, locations };
}

const baseline = parse(await read('nginx.conf'));
const fragment = parse(await read('nginx-locations.conf'));

// 1. location 集合必须完全相同
assert.deepEqual(
  [...fragment.locations.keys()].sort(),
  [...baseline.locations.keys()].sort(),
  'location 集合与 deploy/nginx.conf 不一致',
);

for (const [name, body] of baseline.locations) {
  assert.equal(
    fragment.locations.get(name),
    body,
    `location 内容不一致，改动需同步两份：${name}`,
  );
}

// 2. server 级指令必须相同
assert.deepEqual(
  [...fragment.directives].sort(),
  [...baseline.directives].sort(),
  'server 级指令（root/index/etag/error_page）与 deploy/nginx.conf 不一致',
);

// 3. 两份阿里云配置都必须 include 同一路径
for (const name of ['nginx-ecs-tunnel.conf', 'nginx-ecs-https.conf']) {
  const text = await read(name);
  assert(
    text.includes(`include ${FRAGMENT_PATH};`),
    `${name} 未 include ${FRAGMENT_PATH}`,
  );
}

// 4. 片段注释里声明的安装路径必须与 include 路径一致
const fragmentText = await read('nginx-locations.conf');
assert(
  fragmentText.includes(FRAGMENT_PATH),
  `nginx-locations.conf 注释中声明的安装路径与 ${FRAGMENT_PATH} 不符`,
);

// 5. 阶段一不得监听公网地址；阶段二必须锁住三处管理面
const tunnelText = await read('nginx-ecs-tunnel.conf');
assert(
  /listen\s+127\.0\.0\.1:4173;/.test(tunnelText),
  'nginx-ecs-tunnel.conf 必须仅监听 127.0.0.1:4173',
);
assert(
  !/listen\s+(0\.0\.0\.0|\*):/.test(tunnelText),
  'nginx-ecs-tunnel.conf 不得绑定公网地址',
);

const httpsText = await read('nginx-ecs-https.conf');
for (const guarded of ['location = /manage', 'location ^~ /api/manage/', 'location ^~ /api/sync/']) {
  assert(httpsText.includes(guarded), `nginx-ecs-https.conf 缺少受保护块: ${guarded}`);
}
const realms = new Set((httpsText.match(/auth_basic\s+"([^"]*)"/g) || []).map((s) => s.replace(/\s+/g, ' ')));
assert.equal(realms.size, 1, `auth_basic realm 必须统一，当前有 ${realms.size} 种：${[...realms].join(' / ')}`);

// 6. 任何配置都不得为 /api/archive 单独加鉴权，否则阅读页会被锁死。
// 先剔除注释行：配置里的说明文字本身会提到 /api/archive 和 auth_basic。
const stripComments = (text) =>
  text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

for (const name of ['nginx-ecs-tunnel.conf', 'nginx-ecs-https.conf', 'nginx-locations.conf']) {
  const text = stripComments(await read(name));
  const archiveBlock = text.match(/location[^{]*\/api\/archive[^{]*\{[^}]*\}/);
  if (archiveBlock) {
    assert(
      !archiveBlock[0].includes('auth_basic'),
      `${name} 中 /api/archive 不得加 auth_basic，阅读页依赖它`,
    );
  }
}

console.log('nginx 部署配置与隔离基准一致：');
console.log(`  location 块 ${baseline.locations.size} 个逐一匹配`);
console.log(`  server 级指令 ${baseline.directives.length} 条匹配`);
console.log(`  片段安装路径 ${FRAGMENT_PATH} 两处 include 一致`);
console.log('  阶段一仅监听回环；阶段二锁住 /manage、/api/manage/、/api/sync/ 且 realm 统一');
console.log('\n注意：本脚本只做结构与一致性校验，不替代目标机上的 `nginx -t`。');
