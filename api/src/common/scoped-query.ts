import { z } from 'zod';
import { paginationSchema } from './pagination';
import { uuid } from './validation';

/** `?org_id=` for scoped endpoints (CONTRACTS §10). */
export const orgIdQuery = z.object({ org_id: uuid.optional() });
export const scopedListQuery = paginationSchema.extend({ org_id: uuid.optional() });
