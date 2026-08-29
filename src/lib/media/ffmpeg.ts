import { spawn } from 'node:child_process';
import { createLogger } from '../logger';

const logger = createLogger('ffmpeg');

/**
 * Thin wrappers over the `ffmpeg`/`ffprobe` binaries (installed via apk in the
 * runner image). We shell out rather than depending on an npm wrapper because
 * the Docker build runs `npm ci --ignore-scripts`, which would skip the
 * postinstall download that packages like `ffmpeg-static` rely on.
 *
 * Every function here is best-effort: a machine without ffmpeg (a dev laptop,
 * say) gets `null` and the caller falls back to no-poster behaviour rather than
 * failing the upload.
 */

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** Hard ceiling on a probe/extract so a pathological file can't pin a worker slot. */
const TIMEOUT_MS = 60_000;
/** A poster frame is a photo, not a video — this is plenty for a 1200px derivative. */
const MAX_FRAME_BYTES = 25 * 1024 * 1024;

type RunResult = { ok: true; stdout: Buffer } | { ok: false; error: string };

function run(bin: string, args: string[], { capture = true } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;

    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(r);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: `${bin} timed out after ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS,
    );

    child.stdout?.on('data', (c: Buffer) => {
      if (!capture) return;
      bytes += c.length;
      if (bytes > MAX_FRAME_BYTES) {
        finish({ ok: false, error: `${bin} output exceeded ${MAX_FRAME_BYTES} bytes` });
        return;
      }
      chunks.push(c);
    });
    // Drain stderr (ffmpeg is chatty) — a full pipe buffer would deadlock the child.
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString();
    });

    child.on('error', (err) => {
      // ENOENT here means the binary isn't installed on this machine.
      finish({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, stdout: Buffer.concat(chunks) });
      else finish({ ok: false, error: `${bin} exited ${code}: ${stderr.trim().slice(-500)}` });
    });
  });
}

export type VideoMetadata = { width?: number; height?: number; duration?: number };

/**
 * Read dimensions + duration from a video. `input` may be a local path or an
 * http(s) URL (a presigned R2 GET), in which case ffprobe range-reads only the
 * header rather than pulling the whole file.
 */
export async function probeVideo(input: string): Promise<VideoMetadata | null> {
  const res = await run(FFPROBE, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    input,
  ]);

  if (!res.ok) {
    logger.warn({ error: res.error }, 'ffprobe failed');
    return null;
  }

  try {
    const parsed = JSON.parse(res.stdout.toString()) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    const duration = parsed.format?.duration ? Math.round(Number(parsed.format.duration)) : undefined;
    return {
      width: stream?.width && stream.width > 0 ? stream.width : undefined,
      height: stream?.height && stream.height > 0 ? stream.height : undefined,
      duration: Number.isFinite(duration) && (duration as number) > 0 ? duration : undefined,
    };
  } catch (err) {
    logger.warn({ error: err }, 'ffprobe returned unparseable JSON');
    return null;
  }
}

/**
 * Grab a single frame as a JPEG buffer.
 *
 * Seeks to ~1s (or 10% in for very short clips) because frame 0 of a lot of
 * real-world video is a black or blank fade-in. `-ss` before `-i` is an input
 * seek: ffmpeg jumps straight there instead of decoding everything up to that
 * point, which over an http input becomes a couple of range requests.
 */
export async function extractVideoFrame(
  input: string,
  durationSeconds?: number,
): Promise<Buffer | null> {
  const seek = pickSeekOffset(durationSeconds);

  const attempt = async (offset: number): Promise<Buffer | null> => {
    const res = await run(FFMPEG, [
      '-ss', offset.toFixed(2),
      '-i', input,
      '-frames:v', '1',
      '-an',                       // no audio decoding
      '-f', 'image2',
      '-c:v', 'mjpeg',
      '-q:v', '3',
      '-y',
      'pipe:1',
    ]);
    if (!res.ok) {
      logger.warn({ error: res.error, offset }, 'ffmpeg frame extraction failed');
      return null;
    }
    return res.stdout.length > 0 ? res.stdout : null;
  };

  const frame = await attempt(seek);
  if (frame) return frame;

  // A seek past the last keyframe (or a duration we guessed wrong) yields no
  // frame at all — retry from the very start before giving up.
  if (seek > 0) return attempt(0);
  return null;
}

/** Exported for testing: 1s in, or 10% for clips shorter than ~2s. */
export function pickSeekOffset(durationSeconds?: number): number {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 1;
  if (durationSeconds < 2) return Math.max(0, durationSeconds * 0.1);
  return 1;
}
