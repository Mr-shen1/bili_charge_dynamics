/**
 * 所有 Playwright 配置的公共兜底：用例只访问回环地址，本机若设置了 HTTP(S)_PROXY，
 * webServer 的可用性探测会经代理误判端口“已被占用”而直接失败。这里在配置加载阶段把
 * 127.0.0.1 与 localhost 补进 NO_PROXY，跑测命令不需要额外的环境变量。
 */
const noProxy = new Set(
  (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map(value => value.trim()).filter(Boolean),
);
noProxy.add('127.0.0.1');
noProxy.add('localhost');
process.env.NO_PROXY = [...noProxy].join(',');
