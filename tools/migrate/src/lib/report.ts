// 分析报告的结构与渲染。
//
// 报告有两种消费者：运维（看人类可读摘要）与 CI/自动化（读 JSON）。
// 同一份数据结构同时支撑两者，避免两套逻辑漂移。

export type Severity = 'blocker' | 'warning' | 'info';

export interface Finding {
  /** 稳定的机器码，测试与自动化据此断言 */
  readonly code: string;
  readonly severity: Severity;
  readonly title: string;
  readonly count: number;
  /** 少量样本，够定位问题即可，不要把整个表抄进报告 */
  readonly samples: readonly string[];
  /** 怎么解决；阻塞项尤其需要写清楚 */
  readonly remediation?: string;
}

export interface TableStatus {
  readonly name: string;
  readonly present: boolean;
  readonly rows: number | null;
  readonly note?: string;
}

export interface AnalyzeReport {
  readonly source: string;
  readonly legacyTimeZone: string;
  readonly generatedAt: string;
  readonly tables: readonly TableStatus[];
  readonly counts: Readonly<Record<string, number>>;
  readonly findings: readonly Finding[];
  readonly verdict: 'ok' | 'warnings' | 'blocked';
}

export function summarize(report: AnalyzeReport): {
  blockers: Finding[];
  warnings: Finding[];
  info: Finding[];
} {
  return {
    blockers: report.findings.filter((f) => f.severity === 'blocker'),
    warnings: report.findings.filter((f) => f.severity === 'warning'),
    info: report.findings.filter((f) => f.severity === 'info'),
  };
}

export function decideVerdict(findings: readonly Finding[]): AnalyzeReport['verdict'] {
  if (findings.some((f) => f.severity === 'blocker')) return 'blocked';
  if (findings.some((f) => f.severity === 'warning')) return 'warnings';
  return 'ok';
}

const MARK: Record<Severity, string> = { blocker: '✗ 阻塞', warning: '⚠ 警告', info: '· 提示' };

export function renderReport(report: AnalyzeReport): string {
  const L: string[] = [];
  const { blockers, warnings, info } = summarize(report);

  L.push('Pigeon Skin Server 旧库迁移分析');
  L.push(`源: ${report.source}`);
  L.push(`旧库时区: ${report.legacyTimeZone}`);
  L.push(`生成时间: ${report.generatedAt}`);
  L.push('');

  L.push('── 表与行数 ─────────────────────────────────────────────');
  for (const t of report.tables) {
    const rows = t.present ? String(t.rows ?? '?') : '—';
    const flag = t.present ? '' : t.note === 'dropped' ? '  （有意丢弃）' : '  （缺失）';
    L.push(`  ${t.name.padEnd(24)} ${rows.padStart(10)}${flag}`);
  }
  L.push('');

  if (blockers.length > 0) {
    L.push('── 阻塞项（必须先解决，否则迁移会静默丢数据）───────────');
    for (const f of blockers) L.push(...renderFinding(f));
    L.push('');
  }

  if (warnings.length > 0) {
    L.push('── 警告（不阻塞，但需要知晓或显式接受）─────────────────');
    for (const f of warnings) L.push(...renderFinding(f));
    L.push('');
  }

  if (info.length > 0) {
    L.push('── 提示 ────────────────────────────────────────────────');
    for (const f of info) L.push(...renderFinding(f));
    L.push('');
  }

  const verdictText = {
    ok: '可以开始迁移。',
    warnings: '可以开始迁移，但请先阅读上面的警告。',
    blocked: '** 存在阻塞项，迁移不应开始 ** —— 先解决上面的阻塞项。',
  }[report.verdict];

  L.push('── 结论 ────────────────────────────────────────────────');
  L.push(`  阻塞项 ${blockers.length} · 警告 ${warnings.length} · 提示 ${info.length}`);
  L.push(`  ${verdictText}`);

  return L.join('\n');
}

function renderFinding(f: Finding): string[] {
  const out = [`  [${MARK[f.severity]}] ${f.title}${f.count ? ` —— ${f.count} 条` : ''}`];
  if (f.samples.length > 0) {
    out.push(`        样本: ${f.samples.slice(0, 5).join('  ')}${f.count > 5 ? '  …' : ''}`);
  }
  if (f.remediation) out.push(`        处理: ${f.remediation}`);
  return out;
}

// ── migrate 结果渲染 ─────────────────────────────────────────────────────────

interface StageResultLike {
  readonly stage: string;
  readonly total: number;
  readonly written: number;
  readonly skipped: Readonly<Record<string, number>>;
}

interface MigrateResultLike {
  readonly stages: readonly StageResultLike[];
  readonly r2Objects: ReadonlyMap<string, string>;
  readonly missingTextureFiles: readonly string[];
  readonly dryRun: boolean;
  readonly durationMs: number;
}

export function renderMigrateResult(result: MigrateResultLike): string {
  const L: string[] = [];
  L.push(result.dryRun ? '迁移演练（dry-run，未写入任何数据）' : '迁移完成');
  L.push('');
  L.push('── 阶段统计 ────────────────────────────────────────────');
  for (const s of result.stages) {
    const skipText = Object.entries(s.skipped)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
    L.push(`  ${s.stage.padEnd(16)} 总 ${String(s.total).padStart(8)} · ` +
      `写入 ${String(s.written).padStart(8)}` +
      `${skipText ? ` · 跳过: ${skipText}` : ''}`);
  }
  L.push('');
  L.push(`R2 待上传对象: ${result.r2Objects.size}`);
  if (result.missingTextureFiles.length > 0) {
    L.push(`缺失纹理文件: ${result.missingTextureFiles.length}（这些行已按缺文件策略处理）`);
  }
  L.push(`耗时: ${(result.durationMs / 1000).toFixed(1)}s`);
  return L.join('\n');
}
