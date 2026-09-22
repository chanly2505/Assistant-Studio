import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { UpdateProjectRequest } from '@/modules/content/inputs';
import { deleteProject, getProject, updateProject } from '@/modules/content/projects';

export const dynamic = 'force-dynamic';

const Params = z.object({ projectId: z.string().min(1).max(64) }).strict();
const limit = { key: 'content:write', points: 120, windowSec: 60, onStoreFailure: 'open' } as const;

/** Another user's project answers 404. */
export const GET = withApi({ auth: 'required', params: Params }, async ({ user, params }) =>
  getProject(user.id, params.projectId),
);

/** Details and/or a status move; a move is recorded in the project's history. */
export const PATCH = withApi(
  { auth: 'required', params: Params, body: UpdateProjectRequest, rateLimit: limit },
  async ({ user, params, body }) => updateProject(user.id, params.projectId, body),
);

/** Soft delete. */
export const DELETE = withApi(
  { auth: 'required', params: Params, rateLimit: limit, audit: 'content.project.deleted' },
  async ({ user, params }) => deleteProject(user.id, params.projectId),
);
