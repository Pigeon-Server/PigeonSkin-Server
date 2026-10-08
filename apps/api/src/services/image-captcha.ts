// 自绘图案验证码（driver = 'image'）。
//
// 与第三方验证码不同：出题与校验都在本站完成，无外网依赖，Workers/Node 双运行时可用。
//
// 无状态出题、有状态消费：答案哈希用 HMAC（密钥 SESSION_SECRET）密钥化——
// 即使题面被机器人读出或哈希泄露，没有 SESSION_SECRET 也无法离线穷举答案。
// 签名字符串形如 `<id>.<hmacAnswerHash>.<expiresAtMs>.<sig>`，sig = HMAC(SESSION_SECRET, 前三段)。
// 校验成功后把签名字符串的 SHA-256 写入 auth_attempts（kind='captcha'）做一次性消费，
// 同一题串在 TTL 内不可重放；过期记录由既有 cleanup 任务清理。

import { hashToken } from '@pigeon-skin/auth';
import { hmacSha256 } from './captcha-internal.ts';

export const IMAGE_CAPTCHA_TTL_SECONDS = 300;
const CHALLENGE_BYTES = 16;
const CODE_LENGTH = 4;

/** 题面里容易混淆的字符不出现在候选集里 */
const CODE_CHARS = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';

export interface ImageCaptchaEnv {
  SESSION_SECRET?: string | undefined;
}

export interface ImageCaptchaVerifierEnv extends ImageCaptchaEnv {
  DB?: { prepare: (sql: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown>; first: (row?: string) => Promise<unknown> } } } | undefined;
}

export interface ImageCaptchaChallenge {
  /** 展示给前端的题目标识，校验时原样带回 */
  challengeId: string;
  /** 题面 SVG（字符逐个独立绘制并叠加干扰线） */
  svg: string;
  /** 过期秒数，供前端提示 */
  ttlSeconds: number;
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const b of bytes) code += CODE_CHARS[b % CODE_CHARS.length];
  return code;
}

/** 出一道题 */
export async function issueImageCaptcha(env: ImageCaptchaEnv): Promise<ImageCaptchaChallenge> {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is required for image captcha');

  const code = randomCode();
  const answerHash = await hmacSha256(secret, `image-captcha-answer:${code.toLowerCase()}`);
  const challengeId = mintChallengeId();
  const expiresAt = Date.now() + IMAGE_CAPTCHA_TTL_SECONDS * 1000;
  const payload = `${challengeId}.${answerHash}.${expiresAt}`;
  const signature = await hmacSha256(secret, payload);

  return {
    challengeId: `${payload}.${signature}`,
    svg: renderSvg(code),
    ttlSeconds: IMAGE_CAPTCHA_TTL_SECONDS,
  };
}

function mintChallengeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 校验答案。challengeId 为出题时下发的签名串，answer 为用户输入。
 * 大小写不敏感；过期、签名不符、答案不符都返回 false。
 * 成功后记录一次性消费，同一题串不能再用。
 */
export async function verifyImageCaptcha(
  env: ImageCaptchaVerifierEnv, challengeId: string | undefined, answer: string | undefined,
): Promise<boolean> {
  const secret = env.SESSION_SECRET;
  if (!secret || !challengeId || !answer || !env.DB) return false;

  const parts = challengeId.split('.');
  if (parts.length !== 4) return false;
  const [id, answerHash, expiresAtMs, signature] = parts as [string, string, string, string];
  const expiresAt = Number(expiresAtMs);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expected = await hmacSha256(secret, `${id}.${answerHash}.${expiresAtMs}`);
  if (expected !== signature) return false;
  if ((await hmacSha256(secret, `image-captcha-answer:${answer.trim().toLowerCase()}`)) !== answerHash) return false;

  // 一次性消费：先查消费标记（challengeId 的 SHA-256）是否已落
  // auth_attempts。不能靠 INSERT 冲突做防重——该表没有唯一约束，且部分
  // 索引在 MySQL 上不可用；SELECT + INSERT 的并发竞态窗口极小，TTL 内
  // 并发重放同一题串在 HMAC 密钥化的前提下收益趋近于零。
  const marker = await hashToken(challengeId);
  const consumed = await env.DB
    .prepare("SELECT id FROM auth_attempts WHERE identifier = ? AND kind = 'captcha' LIMIT 1")
    .bind(marker)
    .first();
  if (consumed) return false;
  await env.DB.prepare('INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at) VALUES (?, ?, ?, 1, ?)')
    .bind('', marker, 'captcha', Date.now())
    .run();
  return true;
}

// ── SVG 题面 ─────────────────────────────────────────────────────────────────

const SVG_W = 140;
const SVG_H = 48;

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function randomInt(max: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % max;
}

/**
 * 渲染题面：每个字符独立旋转/错位/变字号，并把字符逐个拆进独立的 text 节点
 * 混入干扰笔画。题面是「防人眼不可读」级别的轻量防护，不抵御 OCR——
 * 强对抗场景应选第三方验证码驱动；离线穷举已被答案哈希的 HMAC 密钥化挡住。
 */
function renderSvg(code: string): string {
  const width = SVG_W / (CODE_LENGTH + 1);
  const chars = [...code].map((ch, i) => {
    const x = width * (i + 0.5) + randomInt(6) - 3;
    const y = SVG_H / 2 + randomInt(10) - 5;
    const rotate = randomInt(50) - 25;
    const size = 22 + randomInt(8);
    return `<text x="${x}" y="${y}" font-size="${size}" transform="rotate(${rotate} ${x} ${y})">${escapeXml(ch)}</text>`;
  }).join('');
  const curves = Array.from({ length: 2 }, () => {
    const y1 = randomInt(SVG_H);
    const y2 = randomInt(SVG_H);
    return `<path d="M 0 ${y1} Q ${SVG_W / 2} ${randomInt(SVG_H)} ${SVG_W} ${y2}" fill="none" stroke="#889" stroke-width="1.5" opacity="0.5"/>`;
  }).join('');
  const dots = Array.from({ length: 24 }, () => `<circle cx="${randomInt(SVG_W)}" cy="${randomInt(SVG_H)}" r="1" opacity="0.4"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}" role="img">`
    + `<g fill="#667" font-family="monospace" text-anchor="middle" dominant-baseline="middle">${chars}</g>${curves}${dots}</svg>`;
}
