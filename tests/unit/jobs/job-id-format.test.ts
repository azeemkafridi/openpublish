/**
 * Guard: BullMQ rejects a custom `jobId` containing ':' — it namespaces its own
 * Redis keys with colons, so `queue.add(..., { jobId })` throws
 * "Custom Id cannot contain :" at runtime.
 *
 * That threw for every engagement check and every RSS feed poll, and the calls
 * are wrapped in `.catch()` or fire from a cron, so nothing surfaced. This test
 * pins the format for the helper and greps the sources so a colon can't be
 * reintroduced in a template literal.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../../src');
const SCRIPTS = path.resolve(__dirname, '../../../scripts');

/** Every `jobId: ...` assignment in a source file, with its file + line. */
function findJobIdAssignments(dir: string): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(p);
      } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        fs.readFileSync(p, 'utf8')
          .split('\n')
          .forEach((text, i) => {
            if (/\bjobId:/.test(text)) out.push({ file: p, line: i + 1, text: text.trim() });
          });
      }
    }
  };
  walk(dir);
  return out;
}

describe('BullMQ job id format', () => {
  it('finds the jobId call sites it is meant to guard', () => {
    const hits = [...findJobIdAssignments(SRC), ...findJobIdAssignments(SCRIPTS)];
    // If this drops to zero the grep has silently stopped guarding anything.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('never builds a jobId containing a colon', () => {
    const hits = [...findJobIdAssignments(SRC), ...findJobIdAssignments(SCRIPTS)];
    const offenders = hits.filter((h) => {
      // Only the jobId VALUE matters — a sibling option like
      // `removeOnComplete: true` on the same line is not an offender.
      const m = h.text.match(/\bjobId:\s*(`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z0-9_$.]+\([^)]*\)|[A-Za-z0-9_$.]+)/);
      return !!m && m[1].includes(':');
    });

    expect(
      offenders.map((o) => `${path.relative(SRC, o.file)}:${o.line} — ${o.text}`),
    ).toEqual([]);
  });

  it('engagementCheckJobId is colon-free and unique per check', async () => {
    const { engagementCheckJobId } = await import('@/lib/jobs/queue');

    const id = engagementCheckJobId(42, 3);
    expect(id).not.toContain(':');
    expect(id).toBe('engagement-42-3');
    // Distinct per check number so the four delayed checks don't collide.
    expect(engagementCheckJobId(42, 1)).not.toBe(engagementCheckJobId(42, 2));
  });
});

export {};
