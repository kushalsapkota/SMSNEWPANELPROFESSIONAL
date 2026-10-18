import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});
export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export function offsetOf(p: Pagination): number {
  return (p.page - 1) * p.page_size;
}

export function page<T>(items: T[], total: number | string | bigint, p: Pagination): Page<T> {
  return { items, total: Number(total), page: p.page, page_size: p.page_size };
}
