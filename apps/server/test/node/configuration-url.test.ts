// 站点地址配置校验：诊断原因必须能指出到底哪里不对（只进日志/后台任务记录，
// 不进客户端响应）。报错本身仍是 503 common.internal_error。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { appUrlProblem, ConfigurationError } from '../../src/services/configuration.ts';

afterEach(() => vi.unstubAllGlobals());

describe('appUrlProblem', () => {
  it('https 根地址通过（带一个尾斜杠也算通过）', () => {
    expect(appUrlProblem('https://skin.example.com', 'production')).toBe('');
    expect(appUrlProblem('https://skin.example.com/', 'production')).toBe('');
  });

  it('非 https 只在 development 放行', () => {
    expect(appUrlProblem('http://localhost:8787', 'development')).toBe('');
    expect(appUrlProblem('http://skin.example.com', 'production')).toContain('必须是 https');
    expect(appUrlProblem('http://skin.example.com', undefined)).toContain('必须是 https');
  });

  it('非法 URL 与带凭据/路径/查询串的地址都给出具体原因', () => {
    expect(appUrlProblem('', 'production')).toContain('不是合法 URL');
    expect(appUrlProblem('skin.example.com', 'production')).toContain('不是合法 URL');
    expect(appUrlProblem('https://user:pass@skin.example.com', 'production')).toContain('用户名或密码');
    expect(appUrlProblem('https://skin.example.com/wiki', 'production')).toContain('站点根');
    expect(appUrlProblem('https://skin.example.com/?lang=zh', 'production')).toContain('查询串');
  });

  it('原因里带上实际值，便于直接定位部署变量', () => {
    expect(appUrlProblem('https://skin.example.com/wiki', 'production')).toContain('https://skin.example.com/wiki');
  });
});

describe('ConfigurationError', () => {
  it('仍是 503 common.internal_error，细节只挂在 reason 上', () => {
    const error = new ConfigurationError('APP_URL 必须是 https 地址（当前 "http://x"）');
    expect(error.status).toBe(503);
    expect(error.code).toBe('common.internal_error');
    expect(error.message).toBe('common.internal_error');
    expect(error.reason).toContain('https');
  });
});
