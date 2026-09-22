import { describe, expect, it } from 'vitest';

import { buildCsp, newNonce } from '@/lib/security/csp';

const directive = (csp: string, name: string) =>
  csp
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1)
    .split(' ') ?? [];

describe('Content-Security-Policy', () => {
  const prod = buildCsp({ nonce: 'abc123', dev: false, https: true });

  it('allows scripts only by nonce in production', () => {
    expect(directive(prod, 'script-src')).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(prod).not.toContain('unsafe-inline');
    expect(prod).not.toContain('unsafe-eval');
  });

  it('forbids framing, plugins and foreign base URLs', () => {
    expect(directive(prod, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(prod, 'object-src')).toEqual(["'none'"]);
    expect(directive(prod, 'base-uri')).toEqual(["'self'"]);
  });

  it('lets forms continue to Google sign-in, and nowhere else', () => {
    expect(directive(prod, 'form-action')).toEqual(["'self'", 'https://accounts.google.com']);
  });

  it('allows images from YouTube thumbnail hosts only', () => {
    expect(directive(prod, 'img-src')).toEqual([
      "'self'",
      'data:',
      'https://i.ytimg.com',
      'https://yt3.ggpht.com',
    ]);
  });

  it('upgrades insecure requests only behind HTTPS in production', () => {
    expect(prod).toContain('upgrade-insecure-requests');
    expect(buildCsp({ nonce: 'x', dev: false, https: false })).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('relaxes only what the dev server needs, in development', () => {
    const dev = buildCsp({ nonce: 'x', dev: true, https: false });
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(dev, 'connect-src')).toContain('ws:');
    expect(directive(dev, 'script-src')).not.toContain("'unsafe-inline'");
  });

  it('makes a fresh, unguessable nonce each time', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(nonces.size).toBe(50);
    expect([...nonces][0]).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
