import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { listGenerations } from '@/modules/ai/history';

export const dynamic = 'force-dynamic';

const Query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();

export const GET = withApi({ auth: 'required', query: Query }, async ({ user, query }) =>
  listGenerations(user.id, query.limit),
);
