import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { selectAsset } from '@/modules/content/assets';

export const dynamic = 'force-dynamic';

const Params = z
  .object({ projectId: z.string().min(1).max(64), assetId: z.string().min(1).max(64) })
  .strict();

/** Versions are immutable; the only change is which one is selected. */
const Body = z.object({ selected: z.literal(true) }).strict();

export const PATCH = withApi(
  {
    auth: 'required',
    params: Params,
    body: Body,
    rateLimit: { key: 'content:write', points: 120, windowSec: 60, onStoreFailure: 'open' },
    audit: 'content.asset.selected',
  },
  async ({ user, params }) => selectAsset(user.id, params.projectId, params.assetId),
);
