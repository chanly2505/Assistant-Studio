import { prisma } from '@/db/prisma';

export interface ActiveSession {
  expires: Date;
  user: { id: string; email: string; locale: string; planKey: string };
}

export const sessionRepository = {
  /**
   * A session counts only if it is unexpired AND its user is active and not
   * soft-deleted. Suspending a user therefore takes effect on their very next
   * request — the benefit of database sessions over JWTs.
   */
  async findActive(sessionToken: string, now = new Date()): Promise<ActiveSession | null> {
    const row = await prisma.session.findUnique({
      where: { sessionToken },
      select: {
        expires: true,
        user: {
          select: {
            id: true,
            email: true,
            locale: true,
            planKey: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!row || row.expires <= now) return null;
    if (row.user.status !== 'ACTIVE' || row.user.deletedAt) return null;

    const { status: _status, deletedAt: _deletedAt, ...user } = row.user;
    return { expires: row.expires, user };
  },

  async deleteAllForUser(userId: string): Promise<number> {
    const { count } = await prisma.session.deleteMany({ where: { userId } });
    return count;
  },
} as const;
