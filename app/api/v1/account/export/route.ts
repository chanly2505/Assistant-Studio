import { NextResponse } from 'next/server';

import { withApi } from '@/lib/api/with-api';
import { exportAccount } from '@/modules/account/account';

export const dynamic = 'force-dynamic';

/** Everything tied to the account, as a JSON file download. docs/architecture/08 §8.7 */
export const GET = withApi(
  {
    auth: 'required',
    // Heavy (reads every table for the user), so sparingly.
    rateLimit: { key: 'account:export', points: 5, windowSec: 3600, onStoreFailure: 'open' },
    audit: 'account.exported',
  },
  async ({ user }) => {
    const result = await exportAccount(user.id);
    if (!result.ok) return result;
    const date = new Date().toISOString().slice(0, 10);
    return new NextResponse(JSON.stringify(result.data, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="youtube-studio-assistant-${date}.json"`,
        'cache-control': 'no-store',
      },
    });
  },
);
