'use strict';

/**
 * 网址归一化：主进程与测试共用的唯一实现。
 * 渲染进程拿不到 require，输入只会原样送进主进程处理，避免两份逻辑分叉。
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;

function normalizeUrl(input) {
  if (typeof input !== 'string') throw new TypeError('网址必须是字符串');

  const raw = input.trim();
  if (!raw) throw new Error('请输入章节网址');

  const candidate = HAS_SCHEME.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`无法识别的网址：${raw}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`只支持 http / https 网址，当前是 ${parsed.protocol.replace(':', '')}`);
  }
  if (!parsed.hostname) throw new Error(`无法识别的网址：${raw}`);

  return parsed.toString();
}

module.exports = { normalizeUrl };
