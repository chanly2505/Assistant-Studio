import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { CreateProjectRequest, PromoteIdeaRequest } from '@/modules/content/inputs';
import { createProject, listProjects, promoteIdea } from '@/modules/content/projects';

export const dynamic = 'force-dynamic';

const Query = z.object({ archived: z.enum(['0', '1']).default('0') }).strict();

export const GET = withApi({ auth: 'required', query: Query }, async ({ user, query }) =>
  listProjects(user.id, { archived: query.archived === '1' }),
);

/** From scratch (`title`), or from an idea (`ideaId`, idempotent). */
export const POST = withApi(
  {
    auth: 'required',
    body: z.union([PromoteIdeaRequest, CreateProjectRequest]),
    successStatus: 201,
    rateLimit: { key: 'content:write', points: 120, windowSec: 60, onStoreFailure: 'open' },
    audit: 'content.project.create',
  },
  async ({ user, body }) =>
    'ideaId' in body ? promoteIdea(user.id, body.ideaId) : createProject(user.id, body),
);
