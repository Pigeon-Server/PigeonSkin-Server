// 阶段共享的执行上下文类型。
//
// stages-core / stages-social 接收它；由 commands/migrate.ts 构造。
import type { SourceAdapter } from '../sources/types.ts';
import type { TargetAdapter } from '../targets/types.ts';
import type { LegacyPasswordAlgo } from '../schema/legacy.ts';

export interface StageContext {
  readonly source: SourceAdapter;
  readonly target: TargetAdapter;
  /** 旧库 datetime 的解释时区 */
  readonly tz: string;
  readonly notificationTz?: string;
  /** 旧密码算法（包装旧哈希用） */
  readonly algo: LegacyPasswordAlgo;
  readonly batchSize: number;
  readonly dryRun: boolean;
  readonly log: (msg: string) => void;
  /** 旧纹理目录里实际存在的哈希；null = 未提供目录（不按文件过滤） */
  readonly presentHashes: Set<string> | null;
  /** 旧纹理目录绝对路径（读 PNG 宽高用）；未提供为 null */
  readonly texturesDir: string | null;
}
