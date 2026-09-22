import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { saveIdea } from '@/modules/ai/history';
import { createIdea, listIdeas } from '@/modules/content/ideas';
import { CreateIdeaRequest } from '@/modules/content/inputs';

export const dynamic = 'force-dynamic';

/** Save one idea from an IDEAS generation. The text comes from the stored output, not the client. */
const SaveFromGeneration = z
  .object({ generationId: z.string().min(1).max(64), index: z.number().int().min(0).max(9) })
  .strict();

const Query = z
  .object({ status: z.enum(['SAVED', 'PROMOTED', 'ARCHIVED']).default('SAVED') })
  .strict();

export const GET = withApi({ auth: 'required', query: Query }, async ({ user, query }) =>
  listIdeas(user.id, query.status),
);

/** Either save an AI idea (by generation + index) or write one by hand. */
export const POST = withApi(
  {
    auth: 'required',
    body: z.union([SaveFromGeneration, CreateIdeaRequest]),
    successStatus: 201,
    rateLimit: { key: 'ideas:save', points: 60, windowSec: 60, onStoreFailure: 'open' },
    audit: 'content.idea.save',
  },
  async ({ user, body }) =>
    'generationId' in body
      ? saveIdea({ userId: user.id, generationId: body.generationId, index: body.index })
      : createIdea(user.id, body),
);
