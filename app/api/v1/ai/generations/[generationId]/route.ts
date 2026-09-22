import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { getGeneration } from '@/modules/ai/history';

export const dynamic = 'force-dynamic';

const Params = z.object({ generationId: z.string().min(1).max(64) }).strict();

/** Another user's generation answers 404. */
export const GET = withApi({ auth: 'required', params: Params }, async ({ user, params }) =>
  getGeneration(user.id, params.generationId),
);
