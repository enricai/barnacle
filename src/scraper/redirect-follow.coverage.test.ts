import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: every bare `fetch(` call in non-test src files must be allowlisted
 * with a reason, so new request sites cannot bypass the redirect follower.
 */
const SRC = join(__dirname, '..');

const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  'src/testmail/client.ts': {
    count: 1,
    reason: 'vendor API probe GET to a fixed vendor endpoint; no site redirects involved',
  },
  'src/scripts/recon-http.ts': {
    count: 1,
    reason: 'robots.txt GET; redirect handling is opted into explicitly via redirect option',
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') walk(p, out);
    } else if (p.endsWith('.ts') && !/\.test\.ts$/.test(p) && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function countBareFetch(text: string): number {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return (stripped.match(/\bfetch\(/g) ?? []).length;
}

describe('redirect follower coverage', () => {
  it('every bare fetch( in src is allowlisted', () => {
    const found: Record<string, number> = {};
    for (const f of walk(SRC)) {
      const n = countBareFetch(readFileSync(f, 'utf8'));
      if (n > 0) found[relative(join(SRC, '..'), f).split(sep).join('/')] = n;
    }
    const actual = Object.fromEntries(
      Object.entries(found).map(([k, v]) => [k, v]),
    );
    const expected = Object.fromEntries(
      Object.entries(ALLOWLIST).map(([k, v]) => [k, v.count]),
    );
    expect(actual).toEqual(expected);
  });

  it('each allowlist entry states a reason', () => {
    for (const [file, entry] of Object.entries(ALLOWLIST)) {
      expect(entry.reason.length, file).toBeGreaterThan(10);
    }
  });
});
