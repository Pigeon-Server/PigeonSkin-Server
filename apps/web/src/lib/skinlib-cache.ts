import type { TextureSummary } from '@/api';
import type { FeedSnapshot } from '@/lib/resource-feed';
export const skinlibCache = new Map<string, FeedSnapshot<TextureSummary> & { scrollY: number }>();
