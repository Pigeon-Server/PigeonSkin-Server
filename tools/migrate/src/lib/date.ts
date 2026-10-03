// 旧库 datetime ↔ UTC epoch 毫秒 的转换。
//
// 这是迁移里最容易出错、且出错后最隐蔽的一环：
// 旧库所有 datetime 都由 Laravel/Carbon 按应用时区写入，而该时区在
// config/app.php:96 硬编码为 'Asia/Shanghai'，列里**不带偏移量也不带时区**。
// 时区弄错会静默平移每一个时间戳 —— 注册时间、上传时间、举报时间全部偏移数小时，
// 直到有人发现某个用户"在未来注册"。
//
// 新库统一存 UTC epoch 毫秒。

const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/**
 * 求某 IANA 时区在给定 UTC 时刻的偏移（毫秒）。
 * 用 Intl 反推，避免引入时区库。
 */
function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // hourCycle h23 在部分环境给出 "24" 表示午夜，取模修正
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - utcMs;
}

/**
 * 把一个不带时区的旧库 datetime 解释为指定时区的本地时间，返回 epoch 毫秒。
 * 非法或空值返回 null（而不是抛错）—— 旧数据里确实有空值。
 */
export function legacyDateTimeToEpoch(
  value: unknown,
  timeZone: string,
  defaultYear = 1970,
): number | null {
  if (value === null || value === undefined) return null;

  // 有些驱动会把 datetime 直接解析成 Date；已经带上了时区语义，直接用
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }

  const text = String(value).trim();
  if (text === '' || text === '0000-00-00 00:00:00') return null;

  const matched = text.match(NAIVE_DATETIME);
  if (!matched) return null;

  const [, y, mo, d, h, mi, s] = matched;
  const year = Number(y ?? defaultYear);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s ?? '0');

  // 显式范围校验。不能只靠 Date.UTC —— 它会把越界值自动进位
  // （13 月变成次年 1 月、45 日变成次月），从而把明显的坏数据"修好"。
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(asUtc)) return null;

  // 回读校验，拦住 2 月 30 日这类"范围合法但该月没有"的日期
  const probe = new Date(asUtc);
  if (
    probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day || probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute || probe.getUTCSeconds() !== second
  ) {
    return null;
  }

  // 先按该时刻的偏移猜一次，再用猜出的时刻复核一次偏移。
  // 两次迭代足以跨过 DST 边界（Asia/Shanghai 现行无 DST，但历史数据可能有）。
  const firstGuess = asUtc - zoneOffsetMs(timeZone, asUtc);
  const refined = asUtc - zoneOffsetMs(timeZone, firstGuess);
  return refined;
}

/** epoch 毫秒 → 指定时区的可读字符串，用于报告 */
export function formatEpoch(epochMs: number | null, timeZone = 'UTC'): string {
  if (epochMs === null) return '—';
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  return dtf.format(new Date(epochMs));
}

/**
 * 旧库用 now()->subDay() 初始化 last_sign_at，以此表示"从未签到"。
 * 由于旧列是 NOT NULL 且没有默认值，这个 workaround 是必需的 —— 判断方式就是
 * 看它是否不晚于注册时间。
 */
export function normalizeLastSignAt(
  lastSignAt: number | null,
  registeredAt: number | null,
): number | null {
  if (lastSignAt === null) return null;
  if (registeredAt !== null && lastSignAt <= registeredAt) return null;
  return lastSignAt;
}
