import type { TextureSummary } from '@/api';

export interface SkinlibCacheData {
  items: TextureSummary[];
  total: number;
  totalPages: number;
  page: number;
  savedAt: number;
  scrollY: number;
}

export const skinlibCache = new Map<string, SkinlibCacheData>();
