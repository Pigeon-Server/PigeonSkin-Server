// D1 形状适配器的公共类型（对齐 @cloudflare/workers-types 的 D1Result）。

export interface D1Meta {
  changes?: number | undefined;
  duration?: number | undefined;
  last_row_id?: number | undefined;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: D1Meta;
}
