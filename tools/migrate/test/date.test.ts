// 旧库时间转换的测试。
//
// 这一层值得单独测：时区弄错会静默平移每一个时间戳 —— 注册时间、上传时间、
// 举报时间全部偏移数小时，而且不会报错，直到有人发现某个用户"在未来注册"。
import { describe, it, expect } from 'vitest';
import {
  formatEpoch,
  legacyDateTimeToEpoch,
  normalizeLastSignAt,
} from '../src/lib/date.ts';

const SH = 'Asia/Shanghai';

describe('legacyDateTimeToEpoch', () => {
  it('把 Asia/Shanghai 的本地时间转成正确的 UTC epoch', () => {
    // 2024-03-15 08:30:00 +08:00 == 2024-03-15T00:30:00Z
    const epoch = legacyDateTimeToEpoch('2024-03-15 08:30:00', SH);
    expect(epoch).toBe(Date.parse('2024-03-15T00:30:00Z'));
  });

  it('上海全年 UTC+8，不同月份的偏移一致', () => {
    const jan = legacyDateTimeToEpoch('2024-01-01 00:00:00', SH)!;
    const jul = legacyDateTimeToEpoch('2024-07-01 00:00:00', SH)!;
    expect(new Date(jan).toISOString()).toBe('2023-12-31T16:00:00.000Z');
    expect(new Date(jul).toISOString()).toBe('2024-06-30T16:00:00.000Z');
  });

  it('支持带 T 分隔与无秒的写法', () => {
    expect(legacyDateTimeToEpoch('2024-03-15T08:30:00', SH))
      .toBe(legacyDateTimeToEpoch('2024-03-15 08:30:00', SH));
    expect(legacyDateTimeToEpoch('2024-03-15 08:30', SH))
      .toBe(legacyDateTimeToEpoch('2024-03-15 08:30:00', SH));
  });

  it('对不同时区给出不同结果（证明它真的在用传入的时区）', () => {
    const sh = legacyDateTimeToEpoch('2024-03-15 08:30:00', SH);
    const utc = legacyDateTimeToEpoch('2024-03-15 08:30:00', 'UTC');
    expect(utc! - sh!).toBe(8 * 3600 * 1000);
  });

  it('处理夏令时切换（用 America/New_York 验证）', () => {
    // 2024-03-10 是美东 DST 切换日：02:00 之前的偏移是 -05:00
    const beforeDst = legacyDateTimeToEpoch('2024-03-10 01:00:00', 'America/New_York')!;
    // 切换之后的偏移是 -04:00
    const afterDst = legacyDateTimeToEpoch('2024-03-10 05:00:00', 'America/New_York')!;
    expect(new Date(beforeDst).toISOString()).toBe('2024-03-10T06:00:00.000Z');
    expect(new Date(afterDst).toISOString()).toBe('2024-03-10T09:00:00.000Z');
  });

  it('空值与非法值返回 null 而不是抛错（旧数据里确实有空值）', () => {
    expect(legacyDateTimeToEpoch(null, SH)).toBeNull();
    expect(legacyDateTimeToEpoch(undefined, SH)).toBeNull();
    expect(legacyDateTimeToEpoch('', SH)).toBeNull();
    expect(legacyDateTimeToEpoch('0000-00-00 00:00:00', SH)).toBeNull();
    expect(legacyDateTimeToEpoch('不是日期', SH)).toBeNull();
    expect(legacyDateTimeToEpoch('2024-13-45 99:99:99', SH)).toBeNull();
  });

  it('已经是 Date 的输入直接使用（有些驱动会预解析）', () => {
    const d = new Date('2024-03-15T00:30:00Z');
    expect(legacyDateTimeToEpoch(d, SH)).toBe(d.getTime());
  });
});

describe('normalizeLastSignAt', () => {
  it('last_sign_at 不晚于注册时间时视为"从未签到"', () => {
    // 旧版注册时把 last_sign_at 写成 now()->subDay()，以此表示没签过到
    const registered = Date.parse('2024-03-15T00:00:00Z');
    const seeded = registered - 86_400_000;
    expect(normalizeLastSignAt(seeded, registered)).toBeNull();
  });

  it('真正签过到的时间被保留', () => {
    const registered = Date.parse('2024-03-15T00:00:00Z');
    const signed = registered + 10 * 86_400_000;
    expect(normalizeLastSignAt(signed, registered)).toBe(signed);
  });

  it('null 保持 null', () => {
    expect(normalizeLastSignAt(null, Date.now())).toBeNull();
  });
});

describe('formatEpoch', () => {
  it('按指定时区格式化，便于人工核对报告', () => {
    const epoch = Date.parse('2024-03-15T00:30:00Z');
    expect(formatEpoch(epoch, SH)).toBe('2024-03-15 08:30:00');
    expect(formatEpoch(epoch, 'UTC')).toBe('2024-03-15 00:30:00');
  });

  it('null 显示为占位符', () => {
    expect(formatEpoch(null)).toBe('—');
  });
});
