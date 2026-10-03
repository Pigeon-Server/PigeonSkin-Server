// 分页读取旧库 + 参数数组绑定 —— 供 stages 系列复用的通用循环。
//
// 这里是唯一做分页读取的地方：query 的第二个实参是值数组，
// SQL 文本永远是调用方传入的静态模板，绝不在本文件里拼值进文本。
import type { SourceAdapter } from '../sources/types.ts';
import type { BoundStatement } from '../targets/types.ts';

export type Row = Record<string, unknown>;

export interface PageLoopOptions {
  readonly source: SourceAdapter;
  readonly countSql: string;
  readonly fetchSql: string;
  readonly batchSize: number;
  readonly skipOffset: number;
  readonly log: (msg: string) => void;
  /** 行过滤器：返回机器码则该行被跳过并计数 */
  readonly skip?: (row: Row) => string | null;
  /** 行映射器：产出绑定了参数的写入语句 */
  readonly map: (row: Row) => BoundStatement;
}

export interface PageLoopResult {
  readonly total: number;
  readonly statements: BoundStatement[];
  readonly skipped: Record<string, number>;
}

/**
 * 按主键序分页读取旧行并全部转成绑定语句。
 * LIMIT/OFFSET 两个数字作为参数数组传给驱动，续跑依赖主键序的稳定性。
 */
export async function pageLoop(opts: PageLoopOptions): Promise<PageLoopResult> {
  const total = await opts.source.scalar<number>(opts.countSql) ?? 0;
  const skipped: Record<string, number> = {};
  const statements: BoundStatement[] = [];
  let offset = opts.skipOffset;

  while (offset < total) {
    const rows = await opts.source.query(opts.fetchSql, [opts.batchSize, offset]);
    if (rows.length === 0) break;

    for (const row of rows) {
      const reason = opts.skip?.(row) ?? null;
      if (reason) {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
        continue;
      }
      statements.push(opts.map(row));
    }

    offset += rows.length;
    opts.log(`  ${Math.min(offset, total)}/${total}`);
  }

  return { total, statements, skipped };
}

/** 按批大小分块提交；dry-run 只计数不落库。返回实际插入的行数。 */
export async function flush(
  target: { runBatch: (s: readonly BoundStatement[]) => Promise<number> },
  statements: readonly BoundStatement[],
  batchSize: number,
  dryRun: boolean,
): Promise<number> {
  if (dryRun || statements.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < statements.length; i += batchSize) {
    inserted += await target.runBatch(statements.slice(i, i + batchSize));
  }
  return inserted;
}
