import { NextResponse } from 'next/server';

import type { AppError } from '@/domain/errors/app-error';

export interface ResponseMeta {
  requestId: string;
  cursor?: string | null;
  hasMore?: boolean;
  [key: string]: unknown;
}

/**
 * BigInt has no JSON representation and `JSON.stringify` throws on it. Every
 * YouTube counter in this schema is a BigInt, so serialisation goes through
 * here rather than through `NextResponse.json`.
 */
export function serialise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialise);
  if (value !== null && typeof value === 'object') {
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
      return (value as { toJSON: () => unknown }).toJSON();
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, serialise(item)]),
    );
  }
  return value;
}

export function jsonOk<T>(data: T, meta: ResponseMeta, init?: ResponseInit): NextResponse {
  return NextResponse.json(
    { data: serialise(data), meta },
    { status: 200, ...init, headers: { 'x-request-id': meta.requestId, ...init?.headers } },
  );
}

export function jsonCreated<T>(data: T, meta: ResponseMeta): NextResponse {
  return jsonOk(data, meta, { status: 201 });
}

export function jsonAccepted<T>(data: T, meta: ResponseMeta): NextResponse {
  return jsonOk(data, meta, { status: 202 });
}

/**
 * The only path from an AppError to the wire. `toClientJSON` decides what is
 * safe to include; nothing else is added here.
 */
export function jsonError(error: AppError, requestId: string): NextResponse {
  const headers: Record<string, string> = { 'x-request-id': requestId };
  if (error.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(error.retryAfterSeconds);
  }

  return NextResponse.json(
    { error: error.toClientJSON(requestId) },
    { status: error.status, headers },
  );
}
