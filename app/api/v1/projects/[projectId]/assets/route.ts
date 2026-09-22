import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { addAsset } from '@/modules/content/assets';
import { AddAssetRequest } from '@/modules/content/inputs';

export const dynamic = 'force-dynamic';

const Params = z.object({ projectId: z.string().min(1).max(64) }).strict();

/** A new version: text the user wrote, or a pick from one of their AI results. */
export const POST = withApi(
  {
    auth: 'required',
    params: Params,
    body: AddAssetRequest,
    successStatus: 201,
    rateLimit: { key: 'content:write', points: 120, windowSec: 60, onStoreFailure: 'open' },
    audit: 'content.asset.added',
  },
  async ({ user, params, body }) => addAsset(user.id, params.projectId, body),
);
