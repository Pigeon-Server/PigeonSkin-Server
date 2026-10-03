// migrate 命令的公共类型。

export type Stage =
  | 'schema' | 'users' | 'textures' | 'players' | 'closet'
  | 'reports' | 'notifications' | 'settings'
  | 'uuid' | 'descriptions' | 'pigeon' | 'files';

export interface StageResult {
  readonly stage: Stage;
  readonly total: number;
  /** 实际落库行数 */
  readonly written: number;
  /** 被唯一约束静默忽略的语句数（INSERT OR IGNORE 吞掉的冲突行） */
  readonly ignored: number;
  /** 各类跳过的计数（机器码 → 次数） */
  readonly skipped: Readonly<Record<string, number>>;
  readonly adjusted?: Readonly<Record<string, number>>;
}
