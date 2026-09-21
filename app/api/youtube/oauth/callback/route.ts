import { NextResponse } from 'next/server';
import { z } from 'zod';

import { AppError } from '@/domain/errors/app-error';
import { withApi } from '@/lib/api/with-api';
import { env } from '@/lib/env';
import { errorRedirectPath, localePath } from '@/lib/i18n/paths';
import { completeChannelConnect } from '@/modules/youtube/complete-channel-connect';

export const dynamic = 'force-dynamic';

/**
 * NOT `.strict()`, unlike every other query schema in this API: Google appends
 * parameters of its own (`scope`, `authuser`, `prompt`, `hd`) that we neither
 * control nor need. Unknown keys are stripped rather than rejected here.
 */
const Query = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(128).optional(),
});

export const GET = withApi(
  {
    auth: 'optional',
    query: Query,
    audit: 'youtube.connect.callback',
    errorRedirect: (error, user) => errorRedirectPath(user?.locale, error, Boolean(user)),
  },
  async ({ user, query, log }) => {
    if (!user) throw new AppError('UNAUTHENTICATED', { detail: 'session lost during consent' });

    const result = await completeChannelConnect({
      sessionUserId: user.id,
      code: query.code,
      state: query.state,
      error: query.error,
      log,
    });
    if (!result.ok) throw result.error;

    const target = localePath(user.locale, `/channels?connected=${result.data.channels.length}`);
    return NextResponse.redirect(new URL(target, env.APP_URL), 303);
  },
);
