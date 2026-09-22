import { aiRoute } from '../_factory';
import { generateTitles } from '@/modules/ai/generate';
import { TitlesRequest } from '@/modules/ai/inputs';

export const dynamic = 'force-dynamic';
// Generation can take a while on the strong model; do not let a platform
// default cut it short.
export const maxDuration = 120;

export const POST = aiRoute({
  slug: 'titles',
  body: TitlesRequest,
  run: (userId, body, log) => generateTitles({ userId, log }, body),
});
