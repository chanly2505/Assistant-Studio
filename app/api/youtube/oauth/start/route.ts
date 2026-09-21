import { NextResponse } from 'next/server';

import { AppError } from '@/domain/errors/app-error';
import { withApi } from '@/lib/api/with-api';
import { errorRedirectPath } from '@/lib/i18n/paths';
import { startChannelConnect } from '@/modules/youtube/start-channel-connect';

export const dynamic = 'force-dynamic';

/**
 * Begins the channel-connect grant. Submitted by a plain HTML form on the
 * Channels page (works without JavaScript), answered with a 303 to Google.
 *
 * POST, not GET: starting an OAuth flow writes a state row, and a GET could be
 * triggered by an <img> tag on any website.
 */
export const POST = withApi(
  {
    auth: 'optional',
    rateLimit: { key: 'youtube:oauth:start', points: 5, windowSec: 3600 },
    audit: 'youtube.connect.start',
    errorRedirect: (error, user) => errorRedirectPath(user?.locale, error, Boolean(user)),
  },
  async ({ user }) => {
    if (!user) throw new AppError('UNAUTHENTICATED');

    const result = await startChannelConnect({ userId: user.id, email: user.email });
    if (!result.ok) throw result.error;

    return NextResponse.redirect(result.data.authorizationUrl, 303);
  },
);
