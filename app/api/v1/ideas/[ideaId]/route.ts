import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { deleteIdea, setIdeaStatus } from '@/modules/content/ideas';
import { UpdateIdeaRequest } from '@/modules/content/inputs';

export const dynamic = 'force-dynamic';

const Params = z.object({ ideaId: z.string().min(1).max(64) }).strict();
const limit = { key: 'content:write', points: 120, windowSec: 60, onStoreFailure: 'open' } as const;

/** Archive or restore. */
export const PATCH = withApi(
  { auth: 'required', params: Params, body: UpdateIdeaRequest, rateLimit: limit },
  async ({ user, params, body }) => setIdeaStatus(user.id, params.ideaId, body.status),
);

/** Promoted ideas cannot be deleted: they are their project's provenance. */
export const DELETE = withApi(
  { auth: 'required', params: Params, rateLimit: limit, audit: 'content.idea.deleted' },
  async ({ user, params }) => deleteIdea(user.id, params.ideaId),
);
