import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { saveIdea } from '@/modules/ai/history';

export const dynamic = 'force-dynamic';

/** Save one idea from an IDEAS generation. The text comes from the stored output, not the client. */
const Body = z
  .object({ generationId: z.string().min(1).max(64), index: z.number().int().min(0).max(9) })
  .strict();

export const POST = withApi(
  {
    auth: 'required',
    body: Body,
    successStatus: 201,
    rateLimit: { key: 'ideas:save', points: 60, windowSec: 60, onStoreFailure: 'open' },
    audit: 'content.idea.save',
  },
  async ({ user, body }) => saveIdea({ userId: user.id, ...body }),
);
