import { channelRepository } from '@/db/repositories/channel.repository';
import { oauthStateRepository } from '@/db/repositories/oauth-state.repository';
import { userRepository } from '@/db/repositories/user.repository';
import { conflict } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';
import { buildAuthorizationUrl, createPkce, createState } from '@/services/google/oauth';

/**
 * Step 1 of the channel-connect grant (Grant B).
 * docs/architecture/05-authentication-architecture.md §5.3
 *
 * Creates a single-use `state` bound to THIS user plus a PKCE verifier, and
 * returns Google's consent URL. Nothing about the user travels in the URL.
 */
export async function startChannelConnect(input: {
  userId: string;
  email: string;
}): Promise<Result<{ authorizationUrl: string }>> {
  // Checked here for a fast, friendly answer, and again at the callback — a user
  // can open several consent tabs before finishing any of them.
  const [{ maxChannels }, connected] = await Promise.all([
    userRepository.planLimits(input.userId),
    channelRepository.countForUser(input.userId),
  ]);
  if (connected >= maxChannels) {
    return err(conflict('errors.channels.limitReached', { limit: maxChannels }));
  }

  const state = createState();
  const pkce = createPkce();

  await oauthStateRepository.purgeExpired();
  await oauthStateRepository.create({ state, userId: input.userId, codeVerifier: pkce.verifier });

  return ok({
    authorizationUrl: buildAuthorizationUrl({
      state,
      codeChallenge: pkce.challenge,
      loginHint: input.email,
    }),
  });
}
