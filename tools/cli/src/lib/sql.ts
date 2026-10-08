// SQL 值转义与行 → INSERT 语句。
// 只用单引号字面量的最小转义规则（' → ''），不构造任何 DDL/DROP 之类
// 可拼接结构；表名、列名来自代码内的白名单，不来自用户输入。

const HEX = /^[0-9a-f]{64}$/;

export function sqlText(v: string): string {
  return `'${v.replaceAll("'", "''")}'`;
}

export function sqlIntOrNull(v: number | null): string {
  if (v === null) return 'NULL';
  if (!Number.isSafeInteger(v)) throw new Error(`非法整数值: ${v}`);
  return String(v);
}

/** textures.hash 列的合法性闸门：必须是小写 sha256 hex（它是 R2 键的推导来源） */
export function isHashHex(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

export function normalizeEmail(email: string): string {
  const t = email.trim();
  if (!t || !t.includes('@') || /\s/.test(t)) throw new Error(`邮箱不合法: ${email}`);
  return t;
}
