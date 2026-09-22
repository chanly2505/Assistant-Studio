import type { ContentSource, Prisma } from '@prisma/client';

import { prisma } from '@/db/prisma';
import { auditRepository } from '@/db/repositories/audit.repository';
import {
  ASSET_MAX_CHARS,
  FEATURE_TO_KIND,
  MAX_VERSIONS_PER_KIND,
  assetTextFromOutput,
  charCount,
  isAssetFeature,
  type AssetKind,
} from '@/domain/content/assets';
import { diffLines } from '@/domain/content/diff';
import { conflict, notFound, toAppError } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';

import type { AddAssetRequest } from './inputs';
import { lockProject, validation } from './shared';

/**
 * Versioned assets. A project gathers titles, descriptions and scripts as
 * numbered versions per kind and locale; exactly one per kind and locale can
 * be the selected ("final") one. Versions are never edited in place — an edit
 * is a new version — so the history of what was tried survives.
 */

interface NewVersion {
  kind: AssetKind;
  locale: string;
  body: string;
  createdBy: ContentSource;
  aiGenerationId: string | null;
}

/** Appends a version under the project lock. The first version of a kind is selected. */
async function appendVersion(
  tx: Prisma.TransactionClient,
  userId: string,
  projectId: string,
  version: NewVersion,
) {
  await lockProject(tx, userId, projectId);

  if (charCount(version.body) > ASSET_MAX_CHARS[version.kind]) {
    throw validation('errors.content.assetTooLong', `${version.kind} over its limit`);
  }

  const scope = { projectId, kind: version.kind, locale: version.locale };
  const [latest, selected, count] = await Promise.all([
    tx.contentAsset.findFirst({
      where: scope,
      orderBy: { version: 'desc' },
      select: { version: true },
    }),
    tx.contentAsset.count({ where: { ...scope, isSelected: true } }),
    tx.contentAsset.count({ where: scope }),
  ]);
  if (count >= MAX_VERSIONS_PER_KIND) {
    throw conflict('errors.content.tooManyVersions', { limit: MAX_VERSIONS_PER_KIND });
  }

  const asset = await tx.contentAsset.create({
    data: {
      ...scope,
      body: version.body,
      version: (latest?.version ?? 0) + 1,
      isSelected: selected === 0,
      createdBy: version.createdBy,
      aiGenerationId: version.aiGenerationId,
    },
    select: { id: true, version: true, isSelected: true },
  });
  // Touch the project so the board orders by real activity.
  await tx.contentProject.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  return asset;
}

/**
 * Adds a version the user wrote, or one taken from an AI result they own.
 * AI text is read from the STORED generation output — the client only says
 * which generation and which pick — so nothing can be saved under the AI's
 * name that the model did not produce. Adding the same AI pick twice returns
 * the version it already created.
 */
export async function addAsset(
  userId: string,
  projectId: string,
  input: AddAssetRequest,
): Promise<
  Result<{ assetId: string; version: number; isSelected: boolean; alreadyAdded: boolean }>
> {
  try {
    if ('kind' in input) {
      const project = await prisma.contentProject.findFirst({
        where: { id: projectId, userId, deletedAt: null },
        select: { locale: true },
      });
      if (!project) throw notFound('project');
      const asset = await prisma.$transaction((tx) =>
        appendVersion(tx, userId, projectId, {
          kind: input.kind,
          locale: input.locale ?? project.locale,
          body: input.body,
          createdBy: 'USER',
          aiGenerationId: null,
        }),
      );
      await audit(userId, projectId, asset.id, { kind: input.kind, source: 'USER' });
      return ok({
        assetId: asset.id,
        version: asset.version,
        isSelected: asset.isSelected,
        alreadyAdded: false,
      });
    }

    const generation = await prisma.aIGeneration.findFirst({
      where: { id: input.generationId, userId },
      select: {
        id: true,
        feature: true,
        status: true,
        locale: true,
        outputJson: true,
        projectId: true,
      },
    });
    if (!generation) throw notFound('generation');
    if (generation.status !== 'OK') {
      throw conflict('errors.content.generationFailed');
    }
    if (!isAssetFeature(generation.feature)) {
      throw validation('errors.content.notAnAsset', `${generation.feature} cannot become an asset`);
    }
    const body = assetTextFromOutput(generation.feature, generation.outputJson, input.pick);
    if (body === null) throw notFound('generation output');
    const kind = FEATURE_TO_KIND[generation.feature];

    const asset = await prisma.$transaction(async (tx) => {
      // Checked under the lock, so a double click cannot add the pick twice.
      await lockProject(tx, userId, projectId);
      const existing = await tx.contentAsset.findFirst({
        where: { projectId, aiGenerationId: generation.id, kind, body },
        select: { id: true, version: true, isSelected: true },
      });
      if (existing) return { ...existing, alreadyAdded: true };

      const created = await appendVersion(tx, userId, projectId, {
        kind,
        locale: generation.locale,
        body,
        createdBy: 'AI',
        aiGenerationId: generation.id,
      });
      // Provenance: the generation now belongs to this project too.
      if (!generation.projectId) {
        await tx.aIGeneration.update({ where: { id: generation.id }, data: { projectId } });
      }
      return { ...created, alreadyAdded: false };
    });
    if (!asset.alreadyAdded) {
      await audit(userId, projectId, asset.id, { kind, source: 'AI', generationId: generation.id });
    }
    return ok({
      assetId: asset.id,
      version: asset.version,
      isSelected: asset.isSelected,
      alreadyAdded: asset.alreadyAdded,
    });
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}

/** Makes one version the selected one for its kind and locale. */
export async function selectAsset(
  userId: string,
  projectId: string,
  assetId: string,
): Promise<Result<{ assetId: string }>> {
  try {
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, userId, projectId);
      const asset = await tx.contentAsset.findFirst({ where: { id: assetId, projectId } });
      if (!asset) throw notFound('asset');
      await tx.contentAsset.updateMany({
        where: {
          projectId,
          kind: asset.kind,
          locale: asset.locale,
          isSelected: true,
          id: { not: asset.id },
        },
        data: { isSelected: false },
      });
      await tx.contentAsset.update({ where: { id: asset.id }, data: { isSelected: true } });
      await tx.contentProject.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
    });
    await auditRepository.record({
      userId,
      action: 'content.asset.selected',
      resourceType: 'ContentAsset',
      resourceId: assetId,
      metadata: { projectId },
    });
    return ok({ assetId });
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}

/** Two versions of the same kind, side by side, as a line diff. */
export async function compareAssets(
  userId: string,
  projectId: string,
  beforeId: string,
  afterId: string,
) {
  const assets = await prisma.contentAsset.findMany({
    where: { id: { in: [beforeId, afterId] }, projectId, project: { userId, deletedAt: null } },
  });
  const before = assets.find((a) => a.id === beforeId);
  const after = assets.find((a) => a.id === afterId);
  if (!before || !after) return err(notFound('asset'));
  if (before.kind !== after.kind) {
    return err(validation('errors.content.compareSameKind', 'different kinds'));
  }
  return ok({ before, after, lines: diffLines(before.body, after.body) });
}

async function audit(
  userId: string,
  projectId: string,
  assetId: string,
  metadata: Prisma.InputJsonObject,
) {
  await auditRepository.record({
    userId,
    action: 'content.asset.added',
    resourceType: 'ContentAsset',
    resourceId: assetId,
    metadata: { projectId, ...metadata },
  });
}
