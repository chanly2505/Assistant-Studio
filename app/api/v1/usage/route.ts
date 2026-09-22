import { withApi } from '@/lib/api/with-api';
import { getUsage } from '@/modules/ai/history';

export const dynamic = 'force-dynamic';

/** Monthly AI allowance: used, remaining and reset date per feature. */
export const GET = withApi({ auth: 'required' }, async ({ user }) => getUsage(user.id));
