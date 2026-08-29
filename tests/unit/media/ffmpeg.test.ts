/**
 * Tests webapp/src/lib/media/ffmpeg.ts — the ffmpeg/ffprobe wrappers used to
 * generate video poster frames.
 *
 * `spawn` is mocked, so nothing shells out. What matters is that a machine
 * without ffmpeg degrades to null instead of throwing, and that the seek offset
 * avoids frame 0 (commonly a black fade-in) without overshooting short clips.
 */
import { EventEmitter } from 'node:events';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
  default: { spawn: (...args: any[]) => mockSpawn(...args) },
}));

vi.mock('@lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { probeVideo, extractVideoFrame, pickSeekOffset } = await import('@/lib/media/ffmpeg');

/** A fake child process that emits `stdout` then closes with `code`. */
function fakeChild({ stdout = '', code = 0, errorMessage = '' }: {
  stdout?: string; code?: number; errorMessage?: string;
}) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    if (errorMessage) {
      child.emit('error', new Error(errorMessage));
      return;
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  }, 0);
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pickSeekOffset', () => {
  it('seeks 1s in by default — frame 0 is often a black fade-in', () => {
    expect(pickSeekOffset(30)).toBe(1);
    expect(pickSeekOffset(undefined)).toBe(1);
    expect(pickSeekOffset(0)).toBe(1);
  });

  it('scales back for clips shorter than the default seek', () => {
    expect(pickSeekOffset(1)).toBeCloseTo(0.1);
    expect(pickSeekOffset(1.5)).toBeCloseTo(0.15);
  });
});

describe('probeVideo', () => {
  it('parses dimensions and duration', async () => {
    mockSpawn.mockReturnValue(
      fakeChild({
        stdout: JSON.stringify({
          streams: [{ width: 1080, height: 1920 }],
          format: { duration: '30.47' },
        }),
      }),
    );

    expect(await probeVideo('/tmp/clip.mp4')).toEqual({
      width: 1080,
      height: 1920,
      duration: 30,
    });
  });

  it('returns null when ffprobe is not installed', async () => {
    mockSpawn.mockReturnValue(fakeChild({ errorMessage: 'spawn ffprobe ENOENT' }));
    expect(await probeVideo('/tmp/clip.mp4')).toBeNull();
  });

  it('returns null on unparseable output', async () => {
    mockSpawn.mockReturnValue(fakeChild({ stdout: 'not json' }));
    expect(await probeVideo('/tmp/clip.mp4')).toBeNull();
  });

  it('drops zero/absent values rather than reporting them as real', async () => {
    mockSpawn.mockReturnValue(
      fakeChild({ stdout: JSON.stringify({ streams: [{ width: 0 }], format: {} }) }),
    );
    expect(await probeVideo('/tmp/clip.mp4')).toEqual({
      width: undefined,
      height: undefined,
      duration: undefined,
    });
  });
});

describe('extractVideoFrame', () => {
  it('returns the frame bytes and seeks before the input', async () => {
    mockSpawn.mockReturnValue(fakeChild({ stdout: 'jpeg-bytes' }));

    const frame = await extractVideoFrame('/tmp/clip.mp4', 30);

    expect(frame?.toString()).toBe('jpeg-bytes');
    const args = mockSpawn.mock.calls[0][1] as string[];
    // `-ss` BEFORE `-i` is an input seek — ffmpeg jumps there instead of
    // decoding everything up to that point.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('pipe:1');
  });

  it('retries from the start when the seek yields no frame', async () => {
    mockSpawn
      .mockReturnValueOnce(fakeChild({ stdout: '' }))
      .mockReturnValueOnce(fakeChild({ stdout: 'jpeg-bytes' }));

    const frame = await extractVideoFrame('/tmp/clip.mp4', 30);

    expect(frame?.toString()).toBe('jpeg-bytes');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect((mockSpawn.mock.calls[1][1] as string[])[1]).toBe('0.00');
  });

  it('returns null when ffmpeg is missing', async () => {
    mockSpawn.mockImplementation(() => fakeChild({ errorMessage: 'spawn ffmpeg ENOENT' }));
    expect(await extractVideoFrame('/tmp/clip.mp4', 30)).toBeNull();
  });

  it('returns null when ffmpeg exits non-zero on both attempts', async () => {
    mockSpawn.mockImplementation(() => fakeChild({ code: 1 }));
    expect(await extractVideoFrame('/tmp/clip.mp4', 30)).toBeNull();
  });
});

export {};
