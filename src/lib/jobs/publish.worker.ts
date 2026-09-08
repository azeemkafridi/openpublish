import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES, addPublishJob, addStatusCheckJob, addMediaCleanupJob, addNotificationJob, addMediaDeleteJob, addEngagementCheckJobs } from './queue';
import { downloadFromR2ToFile, isR2Key } from '../media/r2';
import { db } from '../db';
import { posts, postPlatforms, channels, mediaFiles as mediaFilesTable, type ThreadPart } from '../db/schema';
import { eq, and, or, lt, lte, inArray, sql } from 'drizzle-orm';
import { decrypt, encrypt } from '../auth/crypto';
import { getPlatformHandler } from '../platforms/registry';
import { platformDisplayName } from '../platforms/types';
import type { PlatformName, PostData, ChannelData, MediaFileData } from '../platforms/types';
import { createLogger } from '../logger';
import { logActivity } from '../activity/log';
import { getMediaPublicUrl, convertImageIfNeeded, composeStoryImage } from '../media/upload';
import { extractFirstUrl } from '../url';
import { fetchLinkPreviewCached } from '../link-preview';
import { validateForPlatform, validateThreadPartLengths } from '../platforms/validation';
import { isReconnectError, classifyPublishError } from '../platforms/auth-errors';
import { acquireRefreshLock, releaseRefreshLock, waitForRefreshLock } from '../oauth/refresh-lock';
import { withPlatformSlot } from './platform-semaphore';
import { checkPlatformAllowed } from '../quotas/check';
import { getPlatformAvailabilityFor } from '../platforms/availability';
import { recordFirstCommentResult } from '../posts/first-comment';
import { PUBLISHABLE_APPROVAL_STATUSES } from '../team/approvals';
import { MAX_AUTO_REPUBLISH, AUTO_REPUBLISH_DELAY_MS } from './status-check.worker';

const logger = createLogger('publish-worker');

/**
 * True while this platform row still has budget for an automatic delayed
 * re-publish after the in-band BullMQ attempts are exhausted. Same accounting
 * as the status-check worker's async auto-republish: spends the manual-Retry
 * budget (retryCount/maxRetries) and stops one short of it, so the user always
 * keeps at least one manual retry after we've given up.
 */
function hasAutoRepublishBudget(pp: { retryCount: number | null; maxRetries: number | null }): boolean {
  const budget = Math.min(MAX_AUTO_REPUBLISH, Math.max(0, (pp.maxRetries ?? 3) - 1));
  return (pp.retryCount ?? 0) < budget;
}

// Platform-format conversions (e.g. WebP→JPEG for IG/GMB) are produced on-the-fly
// at publish and stored transiently in R2. Sweep them this long afterwards —
// long enough for pull-based platforms (IG/FB) to have fetched the URL, but they
// are never reused so they don't need to live permanently.
const TRANSIENT_CONVERSION_TTL_MS = 15 * 60 * 1000;

// A post 'publishing'/'processing' for longer than this was stranded by a lost Redis job
// (Redis is intentionally not persisted): its publish job or status-check chain vanished.
// 15 min is comfortably past the ~6 min status-check budget, so we never reclaim a post
// that's still legitimately mid-flight.
const STUCK_RECLAIM_MS = 15 * 60 * 1000;

// Platforms whose handlers upload media bytes from a local file (they fs.read
// mf.localPath) rather than handing the platform a URL to fetch.
// A handler that reads mf.localPath MUST be listed here — otherwise localPath is
// still an R2 key and the read fails with ENOENT at publish time.
const PUSH_PLATFORMS = new Set<PlatformName>(['x', 'linkedin', 'bluesky', 'mastodon', 'youtube', 'tumblr', 'snapchat']);

/**
 * Download any R2-stored media in `files` to local temp files, returning copies
 * whose `localPath` points at the temp file. `cache` dedupes downloads of the
 * same key and `tempFiles` collects the paths to clean up afterwards. Files that
 * are already local (legacy paths) or fail to download are passed through as-is.
 */
async function materializeToLocal(
  files: MediaFileData[],
  cache: Map<string, string>,
  tempFiles: string[],
  postId: number,
): Promise<MediaFileData[]> {
  const out: MediaFileData[] = [];
  for (const mf of files) {
    if (!isR2Key(mf.localPath)) {
      out.push(mf);
      continue;
    }
    let temp = cache.get(mf.localPath);
    if (!temp) {
      try {
        // Stream R2 -> disk. Buffering here (the old downloadFromR2) held the
        // whole object in heap at ~2x file size — a 1GB YouTube video cost
        // ~2GB per post, x3 worker concurrency, on an 8GB box.
        temp = path.join(os.tmpdir(), `pub-${randomBytes(8).toString('hex')}${path.extname(mf.localPath) || ''}`);
        await downloadFromR2ToFile(mf.localPath, temp);
        cache.set(mf.localPath, temp);
        tempFiles.push(temp);
      } catch (err) {
        logger.error({ key: mf.localPath, postId, error: err }, 'Failed to materialize media from R2 for publish');
        // A failed stream can leave a partial temp file — never hand that to a handler.
        if (temp) fs.rmSync(temp, { force: true });
        out.push(mf); // leave as-is; the handler will surface a clear error
        continue;
      }
    }
    out.push({ ...mf, localPath: temp });
  }
  return out;
}

/**
 * Public URL of a video row's extracted poster frame — best derivative first
 * (the 1200px `large` is generated from the poster; see media_files schema).
 * Null when no poster derivative exists yet (upload predates poster generation
 * and the backfill hasn't reached it, or extraction failed).
 */
function posterStoragePath(row: { largePath?: string | null; previewPath?: string | null; thumbnailPath?: string | null }): string | undefined {
  return row.largePath || row.previewPath || row.thumbnailPath || undefined;
}

/**
 * Our poster derivatives are all WebP (see media/thumbnail.ts). Platforms that
 * demand a still cover for a video — Pinterest video pins, Reddit video posts —
 * accept JPEG/PNG only, and Pinterest answers a WebP cover with
 * `400 The format of the image is not supported`. Convert the poster to a
 * format the target platform lists before any handler sees it.
 *
 * Returns the file unchanged when there is no poster, the platform declares no
 * image formats, or the poster is already acceptable. A conversion failure is
 * logged and falls through to the original — the handler's own "no cover"
 * error is a better outcome than losing the post here.
 */
async function withPlatformCompatiblePoster(
  mf: MediaFileData,
  acceptedFormats: string[] | undefined,
  cache: Map<string, string>,
  transientConvertedKeys: Set<string>,
  postId: number,
): Promise<MediaFileData> {
  if (!mf.posterPath || !mf.posterUrl || !acceptedFormats?.length) return mf;

  const ext = mf.posterPath.split('.').pop()?.toLowerCase();
  const normalised = acceptedFormats.map((f) => f.toLowerCase());
  const alreadyOk =
    !!ext &&
    (normalised.includes(ext) ||
      (ext === 'jpg' && normalised.includes('jpeg')) ||
      (ext === 'jpeg' && normalised.includes('jpg')));
  if (alreadyOk) return mf;

  const cacheKey = `${mf.posterPath}::${normalised.join(',')}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...mf, posterUrl: cached };

  const posterMime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/webp';
  try {
    const result = await convertImageIfNeeded(mf.posterPath, posterMime, acceptedFormats);
    if (!result) return mf;
    if (result.localPath.startsWith('converted/')) transientConvertedKeys.add(result.localPath);
    cache.set(cacheKey, result.url);
    return { ...mf, posterUrl: result.url };
  } catch (err) {
    logger.warn({ error: err, posterPath: mf.posterPath, postId }, 'Video poster conversion failed; using the original poster');
    return mf;
  }
}

function cleanupTempFiles(tempFiles: string[]): void {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* best-effort temp cleanup */ }
  }
}

/**
 * Push-based platforms read media from a local file path, but our media lives in
 * R2. Download the bytes those platforms need to local temp files and repoint
 * their media at them. Pull-based platforms (which fetch mf.url) are untouched.
 * Returns the temp paths to clean up once publishing is done.
 */
async function materializeR2MediaForPushPlatforms(
  platforms: Array<{ id: number; platform: string }>,
  platformMediaMap: Map<number, MediaFileData[]>,
  baseMediaFiles: MediaFileData[],
  postId: number,
): Promise<string[]> {
  if (!platforms.some((pp) => PUSH_PLATFORMS.has(pp.platform as PlatformName))) return [];

  const tempFiles: string[] = [];
  const cache = new Map<string, string>();
  for (const pp of platforms) {
    if (!PUSH_PLATFORMS.has(pp.platform as PlatformName)) continue;
    const files = platformMediaMap.get(pp.id) ?? baseMediaFiles;
    platformMediaMap.set(pp.id, await materializeToLocal(files, cache, tempFiles, postId));
  }
  return tempFiles;
}

/**
 * Hard ceiling on a single publish job. Every internal poll loop (X media
 * processing, Facebook story status, etc.) has a worst-case wall-clock below
 * this, so a job that hits it means a genuinely hung connection — better to
 * free the worker slot and let BullMQ retry / reclaimStuckPosts recover than
 * to burn 1 of the 3 concurrency slots until the process restarts.
 */
const PUBLISH_JOB_TIMEOUT_MS = 10 * 60_000;

async function withJobTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${PUBLISH_JOB_TIMEOUT_MS / 1000}s`)), PUBLISH_JOB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * A post's platform rows stranded in 'publishing' mean the publish was cut off
 * mid-flight — a hung job hit the 10-min ceiling, or the process died between
 * the platform API call and the DB write. The platform may have created the
 * post, so these rows must NEVER be blindly re-published: mark them
 * 'unconfirmed' (terminal), notify the user once, and reconcile the post.
 * Rows in 'pending' are untouched — those provably never started.
 */
async function quarantineStrandedPublishing(postId: number, reason: string): Promise<number> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) return 0;

  const stranded = await db
    .update(postPlatforms)
    .set({
      status: 'unconfirmed',
      errorMessage:
        `The publish was interrupted (${reason}) and we could not confirm whether it completed. ` +
        'Check the account before retrying — publishing again could duplicate the post.',
    })
    .where(and(eq(postPlatforms.postId, postId), eq(postPlatforms.status, 'publishing')))
    .returning({ id: postPlatforms.id, platform: postPlatforms.platform, channelId: postPlatforms.channelId });

  if (stranded.length === 0) return 0;

  logger.warn({ postId, reason, platforms: stranded.map((s) => s.platform) }, 'Stranded publishing rows quarantined as unconfirmed');
  await addNotificationJob(
    post.userId,
    'post_failed',
    `Couldn't confirm a post was published`,
    `A publish to ${stranded.map((s) => platformDisplayName(s.platform)).join(', ')} was interrupted (${reason}). ` +
      'Check the account(s) before retrying — publishing again could duplicate the post.',
    { postId, contentSnippet: (post.content || '').slice(0, 80) },
    post.organizationId,
  ).catch(() => {});
  await reconcilePostStatus(postId);
  return stranded.length;
}

export function createPublishWorker() {
  return new Worker(
    QUEUE_NAMES.PUBLISH,
    async (job: Job) => {
      if (job.name === 'check-scheduled') {
        await withJobTimeout(processScheduledPosts(), 'check-scheduled');
        return;
      }

      if (job.name === 'publish-post') {
        // On the last BullMQ attempt, transient failures are surfaced as final
        // failures (user notification + failed status) instead of re-queued.
        // attemptsMade counts COMPLETED attempts (0 on the first run) — BullMQ
        // increments it after the processor returns — so the final run of
        // `attempts` total is attemptsMade === attempts - 1 (same convention as
        // status-check.worker.ts).
        const finalAttempt = (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1) - 1;
        try {
          await withJobTimeout(publishPost(job.data.postId, { finalAttempt }), `publish-post ${job.data.postId}`);
        } catch (err) {
          // A job-ceiling breach means the publish is hung mid-flight with an
          // unknown outcome — Promise.race does NOT cancel it, and a BullMQ
          // retry would run a second publish while the first may still land.
          // Quarantine instead of rethrowing. All other errors (including the
          // deliberate transient-retry throw) keep BullMQ's retry semantics.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('timed out after')) {
            await quarantineStrandedPublishing(job.data.postId, 'the publish job timed out');
            return;
          }
          throw err;
        }
        return;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
      // Deliberate stall handling: CPU-heavy image conversion can block the event
      // loop past the default 30s lock, and a stalled job is failed outright after
      // maxStalledCount. A 60s lock + tolerance of 2 stalls keeps legitimately
      // slow jobs alive; true duplicates are prevented by the DB-level claims.
      lockDuration: 60_000,
      maxStalledCount: 2,
    },
  );
}

async function processScheduledPosts() {
  const now = new Date();

  const scheduledPosts = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.status, 'scheduled'),
        lte(posts.scheduledAt, now),
        // Approval gate: pending/rejected posts stay parked until an approver
        // releases them (the approve endpoint publishes overdue posts itself).
        inArray(posts.approvalStatus, PUBLISHABLE_APPROVAL_STATUSES),
      ),
    )
    .limit(10);

  if (scheduledPosts.length > 0) {
    logger.info({ count: scheduledPosts.length }, 'Processing scheduled posts');

    for (const post of scheduledPosts) {
      // Atomically claim the post before publishing. check-scheduled fires every minute and
      // a slow batch (e.g. a video upload) can overlap the next run; this conditional UPDATE
      // ensures exactly one run transitions scheduled→publishing, so the post is never
      // published twice. A run that loses the claim gets 0 rows back and skips the post.
      const claimed = await db
        .update(posts)
        .set({ status: 'publishing', updatedAt: new Date() })
        .where(and(eq(posts.id, post.id), eq(posts.status, 'scheduled')))
        .returning({ id: posts.id });
      if (claimed.length === 0) continue;

      // Enqueue as a publish-post job (instead of publishing inline) so scheduled
      // posts get the same BullMQ retry-with-backoff semantics on transient
      // platform failures as user-triggered publishes. A lost job is covered by
      // reclaimStuckPosts below.
      await addPublishJob(post.id);
    }
  }

  // Always run — independent of whether any scheduled posts were due.
  await reclaimStuckPosts(now);
}

/**
 * Re-drive posts stranded by a lost Redis job (the queue isn't persisted by design). A
 * 'publishing' post whose publish job vanished is re-published (publishPost transitions it
 * out of 'publishing', so it self-resolves); a 'processing' post whose status-check chain
 * vanished gets a fresh status check per still-processing platform row. Keyed on
 * posts.updatedAt so only genuinely-stuck rows are touched, and we bump updatedAt after
 * handling a 'processing' post so it isn't re-driven every minute while it finishes.
 */
async function reclaimStuckPosts(now: Date) {
  const cutoff = new Date(now.getTime() - STUCK_RECLAIM_MS);
  // `partial` is included because a post can sit there with one platform still
  // in 'processing' (e.g. one channel failed, an async one never confirmed).
  // Those were previously never re-driven, so the post stayed 'partial' forever
  // even after the platform finished. Restricted to partials that actually have
  // a processing row, so genuinely-partial posts don't clog the sweep.
  const stuck = await db
    .select({ id: posts.id, status: posts.status })
    .from(posts)
    .where(
      and(
        lt(posts.updatedAt, cutoff),
        or(
          inArray(posts.status, ['publishing', 'processing']),
          and(
            eq(posts.status, 'partial'),
            sql`EXISTS (
              SELECT 1 FROM ${postPlatforms}
              WHERE ${postPlatforms.postId} = ${posts.id}
                AND ${postPlatforms.status} = 'processing'
            )`,
          ),
        ),
      ),
    )
    .limit(10);

  for (const post of stuck) {
    if (post.status === 'publishing') {
      logger.warn({ postId: post.id }, 'Reclaiming post stuck in publishing');
      // Platform rows still in 'publishing' after STUCK_RECLAIM_MS mean the
      // worker died (or hung) MID-PUBLISH — the platform may have the post.
      // Quarantine those as unconfirmed rather than re-publishing them; rows
      // in 'pending' (never started / deliberately held) are then re-driven
      // safely by publishPost as before.
      await quarantineStrandedPublishing(post.id, 'the worker was interrupted mid-publish');
      await publishPost(post.id);
    } else {
      logger.warn({ postId: post.id, status: post.status }, 'Reclaiming post with unconfirmed processing platforms');
      const procRows = await db
        .select()
        .from(postPlatforms)
        .where(and(eq(postPlatforms.postId, post.id), eq(postPlatforms.status, 'processing')));
      for (const pp of procRows) {
        if (pp.platformPostId) {
          await addStatusCheckJob(pp.id, pp.platform, pp.platformPostId, pp.channelId);
        }
      }
      // Bump updatedAt so the post isn't re-driven next minute while the checks run.
      await db.update(posts).set({ updatedAt: new Date() }).where(eq(posts.id, post.id));
    }
  }
}

/**
 * Recompute a post's overall status from its current platform rows. Used when there are
 * no platforms left to publish (already done by a concurrent run / prior attempt), so we
 * never flip a published post to 'failed'. A post with no platform rows at all is a
 * genuine error and is failed.
 */
async function reconcilePostStatus(postId: number) {
  const all = await db
    .select({ status: postPlatforms.status })
    .from(postPlatforms)
    .where(eq(postPlatforms.postId, postId));

  if (all.length === 0) {
    logger.error({ postId }, 'No platforms selected for post');
    await db.update(posts).set({ status: 'failed', updatedAt: new Date() }).where(eq(posts.id, postId));
    return;
  }

  const statuses = all.map((p) => p.status);
  const hasPublished = statuses.some((s) => s === 'published');
  const hasProcessing = statuses.some((s) => s === 'processing');
  const allDone = statuses.every((s) => s === 'published' || s === 'processing');

  let finalStatus: 'published' | 'partial' | 'failed' | 'processing';
  if (allDone && hasProcessing) finalStatus = 'processing';
  else if (allDone) finalStatus = 'published';
  else if (hasPublished || hasProcessing) finalStatus = 'partial';
  else finalStatus = 'failed';

  await db
    .update(posts)
    .set({
      status: finalStatus,
      publishedAt: hasPublished ? sql`COALESCE(${posts.publishedAt}, NOW())` : undefined,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, postId));
}

/**
 * `finalAttempt` defaults to true (fail visibly) — only the publish-post job
 * handler passes false while BullMQ retry attempts remain, letting transient
 * platform failures re-queue instead of failing the post.
 */
async function publishPost(postId: number, { finalAttempt = true }: { finalAttempt?: boolean } = {}) {
  // Get post with its platform entries
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) {
    logger.error({ postId }, 'Post not found');
    return;
  }

  // The API route (/api/posts/[id]/publish) already marks the post as 'publishing'
  // before enqueueing, so the UPDATE is only needed on the scheduled-checker path
  // where the post comes in as 'scheduled'.
  if (post.status !== 'publishing') {
    await db
      .update(posts)
      .set({ status: 'publishing', updatedAt: new Date() })
      .where(eq(posts.id, postId));
  }

  // Only fetch platforms that still need publishing (pending or in-progress).
  // published/processing entries are already done and must not be re-published on retries.
  const platforms = await db
    .select()
    .from(postPlatforms)
    .where(and(
      eq(postPlatforms.postId, postId),
      inArray(postPlatforms.status, ['pending', 'publishing']),
    ));

  if (platforms.length === 0) {
    // Nothing left to publish: either every platform is already done (a concurrent run or
    // a prior attempt finished first) or the post genuinely has no platforms. Reconcile
    // from the current platform rows instead of blindly failing — otherwise a fully
    // published post can get flipped to 'failed'.
    await reconcilePostStatus(postId);
    return;
  }

  // Batch-mark pending platforms as publishing in one query
  const ppIds = platforms.map((pp) => pp.id);
  await db
    .update(postPlatforms)
    .set({ status: 'publishing' })
    .where(inArray(postPlatforms.id, ppIds));

  // Pre-fetch all channels for this post in one query
  const channelIds = [...new Set(platforms.map((pp) => pp.channelId))];
  const channelRows = await db
    .select()
    .from(channels)
    .where(and(inArray(channels.id, channelIds), eq(channels.organizationId, post.organizationId)));
  const channelMap = new Map(channelRows.map((c) => [c.id, c]));

  // Resolve media files once (same for all platforms)
  const rawMediaIds = Array.isArray(post.mediaFiles) ? post.mediaFiles : [];
  const mediaIds = rawMediaIds
    .map((entry: any) => (typeof entry === 'number' ? entry : entry?.id))
    .filter((id: number) => id && !Number.isNaN(id));

  let resolvedMedia: any[] = [];
  if (mediaIds.length > 0) {
    const rows = await db
      .select()
      .from(mediaFilesTable)
      .where(and(inArray(mediaFilesTable.id, mediaIds), eq(mediaFilesTable.organizationId, post.organizationId)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    resolvedMedia = mediaIds.map((id: number) => byId.get(id)).filter(Boolean);

    // A post that references media MUST publish with that media. The `.filter(Boolean)`
    // above silently drops anything that no longer resolves, and for a
    // media-optional platform the post then goes out as text — or, once the
    // link-card branch below sees an empty media list, as a link post. Either
    // way it is published under the user's name without the image they
    // attached, and nothing reports a problem.
    //
    // Two ways media goes missing after a post is created:
    //   - the row is gone (deleted from the library, or a cross-org id)
    //   - the row survives but its bytes were swept (isOriginalDeleted), which
    //     leaves originalPath pointing at an object that is no longer in R2 —
    //     the publish path never checked this flag, so the platform received a
    //     dead URL and failed with something unrelated to the real cause.
    const missingIds = mediaIds.filter((id: number) => !byId.has(id));
    const deletedIds = resolvedMedia.filter((f) => f.isOriginalDeleted).map((f) => f.id);

    if (missingIds.length > 0 || deletedIds.length > 0) {
      const reasons = [
        missingIds.length > 0 ? `no longer in the media library (id ${missingIds.join(', ')})` : null,
        deletedIds.length > 0 ? `original file was deleted by the retention sweep (id ${deletedIds.join(', ')})` : null,
      ].filter(Boolean).join('; ');
      const errorMsg =
        `Attached media is unavailable: ${reasons}. ` +
        'The post was not published — re-attach the media and retry.';

      logger.warn({ postId, mediaIds, missingIds, deletedIds }, 'Publish aborted: attached media unavailable');
      await db
        .update(postPlatforms)
        .set({ status: 'failed', errorMessage: errorMsg, publishedAt: new Date() })
        .where(inArray(postPlatforms.id, ppIds));
      // reconcilePostStatus writes the post-level activity entry — don't log twice.
      await reconcilePostStatus(postId);
      return;
    }
  }

  const baseMediaFiles: MediaFileData[] = resolvedMedia.map((f) => ({
    url: getMediaPublicUrl(f.originalPath),
    localPath: f.originalPath,
    mimeType: f.mimeType,
    width: f.width,
    height: f.height,
    duration: f.duration,
    sizeBytes: f.sizeBytes,
    // Videos: expose the extracted poster frame (best derivative available) so
    // handlers that need a still image (Pinterest video-pin cover) can use it.
    // The URL is swapped for a format-converted copy per platform below.
    posterPath: f.mimeType?.startsWith('video/') ? posterStoragePath(f) : undefined,
    posterUrl: f.mimeType?.startsWith('video/')
      ? (posterStoragePath(f) ? getMediaPublicUrl(posterStoragePath(f)!) : undefined)
      : undefined,
  }));

  // Thread publishing branch
  if (post.postFormat === 'thread' && post.threadParts) {
    await publishThreadPost(post, platforms, channelMap, postId, finalAttempt);
    return;
  }

  // Legacy pre-generated variants (rows uploaded before on-publish conversion).
  // New uploads have none — the format conversions are produced on-the-fly below
  // and swept after publish, instead of being stored permanently at upload time.
  const variantsByPath = new Map<string, Record<string, { path: string; mimeType: string }>>();
  for (const rm of resolvedMedia) {
    if (rm.variants && Object.keys(rm.variants).length > 0) {
      variantsByPath.set(rm.originalPath, rm.variants);
    }
  }

  // On-the-fly conversions land in R2 under `converted/`. Track them so they can
  // be swept after publish, and dedupe identical conversions (same source +
  // target rules) across platforms within this run.
  const transientConvertedKeys = new Set<string>();
  const conversionCache = new Map<string, MediaFileData>();
  // Converted video posters, keyed by poster path + the platform's format list,
  // so several platforms needing the same JPEG cover convert it once.
  const posterConversionCache = new Map<string, string>();

  // Pre-convert images for each platform BEFORE parallel publish.
  const platformMediaMap = new Map<number, MediaFileData[]>();
  for (const pp of platforms) {
    const handler = getPlatformHandler(pp.platform as PlatformName);
    const imageRules = handler.config.mediaRules?.image;
    const acceptedFormats = imageRules?.formats;
    const maxDimension = imageRules?.maxDimension;

    if ((acceptedFormats && acceptedFormats.length > 0) || maxDimension) {
      const converted: MediaFileData[] = [];
      for (const mf of baseMediaFiles) {
        if (mf.mimeType.startsWith('image/')) {
          // Reuse a legacy pre-generated variant if one happens to exist.
          const variants = variantsByPath.get(mf.localPath);
          const needsJpeg = acceptedFormats && !acceptedFormats.some((f: string) => {
            const origExt = mf.mimeType.split('/')[1]?.replace('jpeg', 'jpg');
            return f.toLowerCase() === origExt || (origExt === 'jpg' && f.toLowerCase() === 'jpeg');
          });
          const variantKey = maxDimension && maxDimension <= 2048 ? 'bluesky' : needsJpeg ? 'jpg_92' : null;

          if (variantKey && variants?.[variantKey]) {
            const v = variants[variantKey];
            converted.push({ ...mf, url: getMediaPublicUrl(v.path), localPath: v.path, mimeType: v.mimeType });
            logger.info({ platform: pp.platform, variant: variantKey }, 'Using pre-generated variant');
            continue;
          }

          // Dedupe: identical source + format/dimension rules → one conversion.
          const cacheKey = `${mf.localPath}::${(acceptedFormats || []).join(',')}::${maxDimension ?? ''}`;
          const cached = conversionCache.get(cacheKey);
          if (cached) {
            converted.push(cached);
            continue;
          }

          try {
            const result = await convertImageIfNeeded(mf.localPath, mf.mimeType, acceptedFormats || [], maxDimension, { width: mf.width, height: mf.height });
            const convertedFile = result
              ? { ...mf, url: result.url, localPath: result.localPath, mimeType: result.mimeType }
              : mf;
            if (result && result.localPath.startsWith('converted/')) {
              transientConvertedKeys.add(result.localPath);
            }
            conversionCache.set(cacheKey, convertedFile);
            converted.push(convertedFile);
          } catch (err) {
            const origExt = mf.mimeType.split('/')[1]?.replace('jpeg', 'jpg');
            const isOrigAccepted = !acceptedFormats || acceptedFormats.length === 0
              || acceptedFormats.some((f) => f.toLowerCase() === origExt || (origExt === 'jpg' && f.toLowerCase() === 'jpeg'));
            if (isOrigAccepted) {
              logger.warn({ error: err, mimeType: mf.mimeType, platform: pp.platform }, 'Image conversion failed, using original');
            } else {
              logger.error({ error: err, mimeType: mf.mimeType, platform: pp.platform }, 'Image conversion failed, format not accepted');
            }
            converted.push(mf);
          }
        } else {
          // Videos pass through, but their WebP poster does not: convert it to
          // something this platform's cover field will accept.
          converted.push(
            await withPlatformCompatiblePoster(mf, acceptedFormats, posterConversionCache, transientConvertedKeys, postId),
          );
        }
      }
      platformMediaMap.set(pp.id, converted);
    } else {
      platformMediaMap.set(pp.id, baseMediaFiles);
    }
  }

  // Download media to local temp files for push-based platforms (their handlers
  // read bytes from disk; our media is in R2). Pull-based platforms use the URL.
  const tempFiles = await materializeR2MediaForPushPlatforms(platforms, platformMediaMap, baseMediaFiles, postId);

  // Publish all platforms concurrently — images converted, push-platform bytes local.
  let outcomes: PromiseSettledResult<'transient' | 'rescheduled' | void>[];
  try {
    outcomes = await Promise.allSettled(
      platforms.map((pp) =>
        // Global per-platform concurrency cap (Redis semaphore) — bounds
        // simultaneous API calls per platform across ALL worker processes.
        withPlatformSlot(pp.platform, () =>
          publishSinglePlatform(pp, post, platformMediaMap.get(pp.id) ?? baseMediaFiles, channelMap, resolvedMedia, postId, finalAttempt),
        ),
      )
    );
  } finally {
    cleanupTempFiles(tempFiles);
  }

  // Sweep the transient on-the-fly conversions after a delay (pull-based
  // platforms have fetched their URLs by then; they're never reused).
  if (transientConvertedKeys.size > 0) {
    await addMediaDeleteJob([...transientConvertedKeys], TRANSIENT_CONVERSION_TTL_MS).catch(() => {});
  }

  // Any platform hit a transient error (rate limit / 5xx / network) and was reset
  // to 'pending': throw so BullMQ retries this job with backoff. Published and
  // processing rows are excluded from the retry's platform query, so only the
  // transient failures are re-attempted. The post stays 'publishing' meanwhile.
  const hasTransient = outcomes.some((o) => o.status === 'fulfilled' && o.value === 'transient');
  if (hasTransient) {
    // Bump updatedAt before throwing so reclaimStuckPosts doesn't re-drive this post
    // on its very next tick. publishPost() skips the 'publishing' status write when the
    // post is ALREADY 'publishing' (the reclaim path), so without this the row keeps its
    // old updatedAt, stays past the cutoff forever, and is re-published every minute.
    // With a held platform (PLATFORM_<NAME>=off) that also starves the LIMIT 10 reclaim
    // batch, so genuinely stranded posts would never be recovered while a platform is off.
    // Mirrors what the 'processing' branch of reclaimStuckPosts already does.
    await db.update(posts).set({ updatedAt: new Date() }).where(eq(posts.id, postId));
    throw new Error(`Transient platform failure for post ${postId} — retrying`);
  }

  // A platform failed transiently on the FINAL in-band attempt and its row was
  // reset to 'pending' with a retryCount bump (rescheduleForRetry). Keep the
  // post 'publishing', schedule a delayed re-publish (the fresh job gets its
  // own in-band attempts), and skip finalization + notifications — already-
  // published rows are excluded from the re-run by the platform query. The
  // 5-min delay stays under STUCK_RECLAIM_MS, and the bumped updatedAt keeps
  // the reclaim sweep from re-driving this post before the delayed job runs.
  const hasRescheduled = outcomes.some((o) => o.status === 'fulfilled' && o.value === 'rescheduled');
  if (hasRescheduled) {
    await db.update(posts).set({ updatedAt: new Date() }).where(eq(posts.id, postId));
    await addPublishJob(postId, AUTO_REPUBLISH_DELAY_MS);
    logActivity({
      userId: post.userId,
      organizationId: post.organizationId,
      action: 'post.retried',
      resourceId: postId,
      details: { auto: true, reason: 'transient failure persisted through in-band retries' },
      level: 'warning',
    });
    logger.warn({ postId }, 'Delayed re-publish scheduled after final-attempt transient failure');
    return;
  }

  // Derive final post status from ALL platform statuses (not just the current batch),
  // so retries that only process failed platforms still see already-published ones.
  const allPlatformStatuses = await db
    .select({ status: postPlatforms.status })
    .from(postPlatforms)
    .where(eq(postPlatforms.postId, postId));

  const statuses = allPlatformStatuses.map((p) => p.status);
  const hasPublished  = statuses.some((s) => s === 'published');
  const hasFailed     = statuses.some((s) => s === 'failed');
  const hasProcessing = statuses.some((s) => s === 'processing');
  const allDone       = statuses.every((s) => s === 'published' || s === 'processing');

  let finalStatus: 'published' | 'partial' | 'failed' | 'processing';
  if (allDone && hasProcessing) {
    finalStatus = 'processing';
  } else if (allDone) {
    finalStatus = 'published';
  } else if (hasPublished || hasProcessing) {
    finalStatus = 'partial';
  } else {
    finalStatus = 'failed';
  }

  await db
    .update(posts)
    .set({
      status: finalStatus,
      // COALESCE, not `new Date()` — recomputing after a retry must not
      // overwrite when the post first went live.
      publishedAt: hasPublished ? sql`COALESCE(${posts.publishedAt}, NOW())` : undefined,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, postId));

  const levelMap = { published: 'info' as const, partial: 'warning' as const, failed: 'error' as const, processing: 'info' as const };
  logActivity({
    userId: post.userId,
    organizationId: post.organizationId,
    action: finalStatus === 'published' ? 'post.published' : finalStatus === 'partial' ? 'post.partially_published' : 'post.publish_failed',
    resourceId: postId,
    details: { platforms: platforms.length },
    level: levelMap[finalStatus],
  });

  // If all published, queue media cleanup
  if (finalStatus === 'published' && post.deleteMediaAfterPublish) {
    await addMediaCleanupJob(postId);
  }

  // Auto-plug/auto-repost: schedule the bounded engagement checks (1h/6h/24h/72h).
  // Deterministic jobIds make this idempotent across publish retries and
  // partial→published transitions.
  if (hasPublished && (post.autoPlugEnabled || post.autoRepostEnabled)) {
    await addEngagementCheckJobs(postId).catch((err) => {
      logger.error({ postId, error: String(err) }, 'Failed to schedule engagement checks');
    });
  }

  logger.info({ postId, finalStatus }, 'Post publish completed');
}

async function publishThreadPost(
  post: any,
  platforms: any[],
  channelMap: Map<number, any>,
  postId: number,
  finalAttempt = true,
) {
  const globalThreadParts = post.threadParts as ThreadPart[];
  const platformThreadParts = (post.platformThreadParts ?? {}) as Record<string, ThreadPart[]>;

  // Collect all media IDs across global + platform-specific thread parts
  const allParts = [
    ...globalThreadParts,
    ...Object.values(platformThreadParts).flat(),
  ];
  const allMediaIds = [...new Set(allParts.flatMap((p) => p.mediaFileIds))];
  let mediaById = new Map<number, any>();
  if (allMediaIds.length > 0) {
    const rows = await db
      .select()
      .from(mediaFilesTable)
      .where(and(inArray(mediaFilesTable.id, allMediaIds), eq(mediaFilesTable.organizationId, post.organizationId)));
    mediaById = new Map(rows.map((r) => [r.id, r]));
  }

  // Batch-mark all platform entries as publishing
  const ppIds = platforms.map((pp) => pp.id);
  await db
    .update(postPlatforms)
    .set({ status: 'publishing' })
    .where(inArray(postPlatforms.id, ppIds));

  // Publish all platforms concurrently — each platform is independent
  const threadOutcomes = await Promise.allSettled(
    platforms.map((pp) =>
      withPlatformSlot(pp.platform, () =>
        publishSingleThreadPlatform(pp, post, channelMap, mediaById, globalThreadParts, platformThreadParts, postId, finalAttempt),
      ),
    )
  );

  // Same transient-retry contract as the single-post path: a deferred platform
  // was reset to 'pending' (thread resume state preserved), so throw to trigger
  // the BullMQ retry, which resumes from threadPostIds.
  const threadHasTransient = threadOutcomes.some((o) => o.status === 'fulfilled' && o.value === 'transient');
  if (threadHasTransient) {
    // See the single-post path: bump updatedAt so the reclaim sweep backs off for a
    // full STUCK_RECLAIM_MS instead of re-driving this post every minute.
    await db.update(posts).set({ updatedAt: new Date() }).where(eq(posts.id, postId));
    throw new Error(`Transient platform failure for thread post ${postId} — retrying`);
  }

  // Same delayed-re-publish contract as the single-post path: keep the post
  // 'publishing' and let the delayed job re-drive the pending rows.
  const threadHasRescheduled = threadOutcomes.some((o) => o.status === 'fulfilled' && o.value === 'rescheduled');
  if (threadHasRescheduled) {
    await db.update(posts).set({ updatedAt: new Date() }).where(eq(posts.id, postId));
    await addPublishJob(postId, AUTO_REPUBLISH_DELAY_MS);
    logActivity({
      userId: post.userId,
      organizationId: post.organizationId,
      action: 'post.retried',
      resourceId: postId,
      details: { auto: true, reason: 'transient failure persisted through in-band retries' },
      level: 'warning',
    });
    logger.warn({ postId }, 'Delayed thread re-publish scheduled after final-attempt transient failure');
    return;
  }

  const allPlatformStatuses = await db
    .select({ status: postPlatforms.status })
    .from(postPlatforms)
    .where(eq(postPlatforms.postId, postId));

  const tStatuses = allPlatformStatuses.map((p) => p.status);
  const tHasPublished = tStatuses.some((s) => s === 'published');
  const tAllDone      = tStatuses.every((s) => s === 'published');

  const finalStatus = tAllDone ? 'published' : tHasPublished ? 'partial' : 'failed';

  await db
    .update(posts)
    .set({
      status: finalStatus,
      publishedAt: tHasPublished ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, postId));

  logActivity({
    userId: post.userId,
    organizationId: post.organizationId,
    action: finalStatus === 'published' ? 'post.published' : finalStatus === 'partial' ? 'post.partially_published' : 'post.publish_failed',
    resourceId: postId,
    details: { platforms: platforms.length, threadParts: globalThreadParts.length },
    level: finalStatus === 'published' ? 'info' : finalStatus === 'partial' ? 'warning' : 'error',
  });

  if (finalStatus === 'published' && post.deleteMediaAfterPublish) {
    await addMediaCleanupJob(postId);
  }

  // Same engagement-check scheduling as regular posts (threads support auto-plug too;
  // the comment/repost targets the thread head via platformPostId).
  if (tHasPublished && (post.autoPlugEnabled || post.autoRepostEnabled)) {
    await addEngagementCheckJobs(postId).catch((err) => {
      logger.error({ postId, error: String(err) }, 'Failed to schedule engagement checks');
    });
  }

  logger.info({ postId, finalStatus, parts: globalThreadParts.length }, 'Thread publish completed');
}

async function publishSinglePlatform(
  pp: any,
  post: any,
  baseMediaFiles: MediaFileData[],
  channelMap: Map<number, any>,
  resolvedMedia: any[],
  postId: number,
  finalAttempt = true,
): Promise<'transient' | 'rescheduled' | void> {
  // Reset this platform row to 'pending' so the retrying publish job picks it
  // up again, and record why. No failure notification — the user only hears
  // about it if the final attempt also fails.
  const deferForRetry = async (errorMessage: string) => {
    await db
      .update(postPlatforms)
      .set({ status: 'pending', errorMessage })
      .where(eq(postPlatforms.id, pp.id));
    logger.warn({ postId, platform: pp.platform, error: errorMessage }, 'Transient publish failure — deferred for retry');
    return 'transient' as const;
  };

  // The FINAL in-band attempt also failed transiently. The in-band retries all
  // land within ~15s (attempts: 3, exponential from 5s) — too short for a
  // platform blip that lasts minutes (e.g. Pinterest error 12 outlasted them on
  // 2026-08-07, posts 698/699). Instead of failing the post and emailing, hand
  // it a delayed re-publish with the same budget the status-check worker uses;
  // the user is only notified once the budget runs out.
  const rescheduleForRetry = async (errorMessage: string) => {
    await db
      .update(postPlatforms)
      .set({
        status: 'pending',
        errorMessage,
        retryCount: sql`${postPlatforms.retryCount} + 1`,
      })
      .where(eq(postPlatforms.id, pp.id));
    logger.warn(
      { postId, platform: pp.platform, attempt: (pp.retryCount ?? 0) + 1, error: errorMessage },
      'Transient failure on the final attempt — scheduling a delayed re-publish',
    );
    return 'rescheduled' as const;
  };

  // The request may have REACHED the platform but its response was lost
  // (timeout / abort / connection reset mid-flight). The post could be live —
  // re-publishing would duplicate it. Terminal state: excluded from every
  // retry/reclaim path; the user decides after checking the account.
  const markUnconfirmed = async (errorMessage: string) => {
    const friendly =
      `The post was sent to ${platformDisplayName(pp.platform)} but we could not confirm it was published ` +
      `(${errorMessage}). Check your ${platformDisplayName(pp.platform)} account before retrying — ` +
      'publishing again could duplicate the post.';
    await db
      .update(postPlatforms)
      .set({ status: 'unconfirmed', errorMessage: friendly })
      .where(eq(postPlatforms.id, pp.id));
    logger.warn({ postId, platform: pp.platform, error: errorMessage }, 'Publish outcome unknown — marked unconfirmed');
    await addNotificationJob(
      post.userId,
      'post_failed',
      `Couldn't confirm your ${platformDisplayName(pp.platform)} post`,
      friendly,
      { postId, platform: pp.platform, channelId: pp.channelId, contentSnippet: (post.content || '').slice(0, 80) },
      post.organizationId,
    );
  };

  try {
    const channel = channelMap.get(pp.channelId);
    if (!channel) {
      await db
        .update(postPlatforms)
        .set({ status: 'failed', errorMessage: 'Channel not found' })
        .where(eq(postPlatforms.id, pp.id));
      return;
    }

    // The platform already told us this token is dead (set on a prior failure).
    // Fail fast without calling the API or re-notifying — the user was alerted
    // when it first broke and the channel shows "Reconnect" in the UI. This is
    // what stops a single revoked account from generating a failure (and email)
    // for every subsequent post.
    if (channel.needsReconnect) {
      await db
        .update(postPlatforms)
        .set({
          status: 'failed',
          errorMessage: `${platformDisplayName(pp.platform)} needs to be reconnected — its access was revoked or expired.`,
        })
        .where(eq(postPlatforms.id, pp.id));
      return;
    }

    // Platform kill switch (`PLATFORM_<NAME>=off`) — we've lost the integration
    // or pulled it deliberately. HOLD the post rather than failing it: reset to
    // 'pending' and defer, so it publishes by itself once the flag flips back.
    // Reuses the transient path — BullMQ retries with backoff, and past that
    // reclaimStuckPosts re-drives the still-'publishing' post every ~15 min.
    const channelAvailability = getPlatformAvailabilityFor(pp.platform, channel.accountType);
    if (!channelAvailability.canPublish) {
      return deferForRetry(
        channelAvailability.message ??
          `${platformDisplayName(pp.platform)} is temporarily unavailable — this post is on hold and will publish automatically once it's back.`,
      );
    }

    // Verify platform is allowed on current plan (prevents publishing after downgrade)
    const platformCheck = await checkPlatformAllowed(post.organizationId, pp.platform);
    if (!platformCheck.allowed) {
      await db
        .update(postPlatforms)
        .set({ status: 'failed', errorMessage: `Platform ${pp.platform} is not available on current plan` })
        .where(eq(postPlatforms.id, pp.id));
      return;
    }

    const handler = getPlatformHandler(pp.platform as PlatformName);
    const postType = post.postTypeOverrides?.[pp.platform] || undefined;

    // Media is pre-converted before parallel publish — use as-is
    const mediaFiles = [...baseMediaFiles];

    // platform_content is jsonb — a malformed API payload can leave a non-string
    // here (e.g. {"youtube": {"content": "..."}}), which would crash every
    // handler that treats content as a string. Only a string override wins.
    const platformOverride = (post.platformContent as Record<string, unknown>)?.[pp.platform];
    const postData: PostData = {
      content: (typeof platformOverride === 'string' ? platformOverride : '') || post.content || '',
      mediaUrls: mediaFiles.map((f) => f.url),
      mediaFiles,
      postType,
      platformSpecific: post.platformSpecific?.[pp.platform] as Record<string, unknown>,
    };

    // Link shortening/click tracking is a cloud feature — content publishes
    // with its original URLs on self-host.
    const originalByShortUrl: Record<string, string> = {};

    // Auto-detect link for platforms that support link cards (no media = link post).
    // Unfurl the URL so the card carries a real title/description/image (Bluesky's
    // external embed renders these; other platforms unfurl the URL themselves).
    // Best-effort: fall back to a bare url-only card if the fetch fails.
    if (postData.mediaFiles.length === 0) {
      const firstUrl = extractFirstUrl(postData.content);
      if (firstUrl) {
        // Unfurl the DESTINATION, not the shortlink: fetching our own redirector
        // would yield a 302 with no OG tags and a blank card. The card's `url`
        // still points at the shortlink so the click is tracked.
        const unfurlTarget = originalByShortUrl[firstUrl] ?? firstUrl;
        const unfurled = await fetchLinkPreviewCached(unfurlTarget).catch(() => null);
        postData.linkPreview = unfurled
          ? { ...unfurled, url: firstUrl }
          : { title: '', description: '', image: '', url: firstUrl };
      }
    }

    const channelData: ChannelData = {
      id: channel.id,
      platform: channel.platform as PlatformName,
      accountId: channel.accountId,
      accountName: channel.accountName,
      accountType: channel.accountType ?? undefined,
      accessToken: channel.accessToken ? decrypt(channel.accessToken) : '',
      refreshToken: channel.refreshToken
        ? decrypt(channel.refreshToken)
        : undefined,
      metadata: channel.metadata as Record<string, unknown>,
      organizationId: post.organizationId,
    };

    // Pre-publish validation — catch issues before wasting API calls
    const validationErrors = validateForPlatform(postData, pp.platform as PlatformName, postType);
    if (validationErrors.length > 0) {
      const errorMsg = validationErrors.map((e) => e.message).join('; ');
      logger.warn({ platform: pp.platform, errors: validationErrors }, 'Pre-publish validation failed');
      await db
        .update(postPlatforms)
        .set({ status: 'failed', errorMessage: errorMsg, publishedAt: new Date() })
        .where(eq(postPlatforms.id, pp.id));
      return;
    }

    let result = await handler.publishPost(postData, channelData);

    // The access token expired between the last refresh and now. Refresh immediately and
    // retry once rather than failing the post and forcing a reconnect. Matches a 401 from
    // OAuth platforms and Bluesky's "ExpiredToken" (HTTP 400) — Bluesky access JWTs live
    // only ~2h and aren't in the proactive sweep, so on-demand refresh here is what keeps
    // those channels alive (and stops a valid refresh token being mis-flagged needsReconnect).
    if (!result.success && result.error && /\b401\b|unauthorized|expired.?token|token has expired/i.test(result.error) && channelData.refreshToken) {
      logger.info({ platform: pp.platform, channelId: channel.id }, 'Publish failed on an expired token — refreshing and retrying');
      // Single-flight the refresh: if the sweep or another concurrent publish is already
      // refreshing this channel, refreshing again would race the rotating token and could
      // invalidate it (false needsReconnect). Hold the lock to refresh, or wait + reuse.
      if (await acquireRefreshLock(channel.id)) {
        try {
          const freshTokens = await handler.refreshToken(channelData.refreshToken, channelData.accountType).catch(() => null);
          if (freshTokens) {
            const tokenUpdates: Record<string, unknown> = {
              accessToken: encrypt(freshTokens.accessToken),
              updatedAt: new Date(),
            };
            if (freshTokens.refreshToken) tokenUpdates.refreshToken = encrypt(freshTokens.refreshToken);
            if (freshTokens.expiresIn) tokenUpdates.tokenExpiresAt = new Date(Date.now() + freshTokens.expiresIn * 1000);
            await db.update(channels).set(tokenUpdates).where(eq(channels.id, channel.id));
            channelData.accessToken = freshTokens.accessToken;
            if (freshTokens.refreshToken) channelData.refreshToken = freshTokens.refreshToken;
            result = await handler.publishPost(postData, channelData);
            logger.info({ platform: pp.platform, success: result.success }, 'Retry after token refresh');
          }
        } finally {
          await releaseRefreshLock(channel.id);
        }
      } else {
        // Another path is refreshing this channel — wait for it, then retry with the
        // freshly-persisted token rather than refreshing again.
        await waitForRefreshLock(channel.id);
        const [fresh] = await db
          .select({ accessToken: channels.accessToken })
          .from(channels)
          .where(eq(channels.id, channel.id))
          .limit(1);
        if (fresh?.accessToken) {
          channelData.accessToken = decrypt(fresh.accessToken);
          result = await handler.publishPost(postData, channelData);
          logger.info({ platform: pp.platform, success: result.success }, 'Retry after waiting for a concurrent token refresh');
        }
      }
    }

    if (result.success) {
      if (result.processing && !result.processingId && !result.postId) {
        // A processing result with no id can never be status-checked or reclaimed
        // (the stuck-reclaimer skips NULL-id rows) — fail it instead of stranding
        // the row in 'processing' forever.
        result = { success: false, error: 'Platform reported processing but returned no id to poll' };
      }
    }

    if (result.success) {
      if (result.processing) {
        // Async processing (TikTok, Instagram, Threads)
        await db
          .update(postPlatforms)
          .set({
            status: 'processing',
            platformPostId: result.processingId || result.postId,
            // Some platforms (e.g. YouTube) know the final permalink at publish
            // time even though the media is still processing. Persist it now so
            // the calendar link works; status-check will not clobber it.
            ...(result.url ? { platformUrl: result.url } : {}),
          })
          .where(eq(postPlatforms.id, pp.id));

        // Queue status check
        if (result.processingId || result.postId) {
          await addStatusCheckJob(
            pp.id,
            pp.platform,
            (result.processingId || result.postId)!,
            pp.channelId,
          );
        }
      } else {
        await db
          .update(postPlatforms)
          .set({
            status: 'published',
            platformPostId: result.postId,
            platformUrl: result.url,
            publishedAt: new Date(),
            // A deferred/rescheduled retry leaves the transient error on the row;
            // clear it so a published post doesn't show a stale failure.
            errorMessage: null,
          })
          .where(eq(postPlatforms.id, pp.id));
      }

      // "Also share to Story" — fire-and-forget after the main post succeeds.
      // IG/FB Stories are 9:16; feed images rarely are, so we compose a 1080x1920
      // version with a blurred background + centered foreground (matches the IG
      // native Share-to-Story look). Fast path: cached story_9_16 variant.
      // Slow path: compose on-the-fly for older media uploaded before variants.
      const platSpec = postData.platformSpecific as Record<string, unknown> | undefined;
      if (platSpec?.shareToStory && postData.mediaFiles.length > 0 && (pp.platform === 'facebook' || pp.platform === 'instagram')) {
        try {
          const originalFile = postData.mediaFiles[0];
          const originalMedia = resolvedMedia[0];
          let storyFile = originalFile;

          const cachedVariant = originalMedia?.variants?.story_9_16 as { path: string; mimeType: string } | undefined;
          if (cachedVariant) {
            storyFile = {
              ...originalFile,
              url: getMediaPublicUrl(cachedVariant.path),
              localPath: cachedVariant.path,
              mimeType: cachedVariant.mimeType,
              width: 1080,
              height: 1920,
            };
          } else if (originalFile.mimeType.startsWith('image/')) {
            // On-the-fly compose for media uploaded before the variant existed.
            const composed = await composeStoryImage(
              originalFile.localPath,
              originalFile.mimeType,
              { width: originalFile.width, height: originalFile.height },
            );
            if (composed) {
              storyFile = {
                ...originalFile,
                url: composed.url,
                localPath: composed.localPath,
                mimeType: composed.mimeType,
                width: 1080,
                height: 1920,
              };
              logger.info({ platform: pp.platform, source: originalFile.localPath }, 'Composed story image on-the-fly (no cached variant)');
            }
          }

          const storyData: PostData = {
            ...postData,
            postType: 'story',
            mediaFiles: [storyFile],
            mediaUrls: [storyFile.url],
          };
          const storyResult = await handler.publishPost(storyData, channelData);
          logger.info({ platform: pp.platform, success: storyResult.success, usedVariant: !!cachedVariant }, 'Share to Story result');

          // Sweep the on-the-fly 9:16 composite after a delay (the platform has
          // fetched it by then). Don't touch the original or a legacy variant.
          if (storyFile.localPath !== originalFile.localPath && storyFile.localPath.startsWith('converted/')) {
            await addMediaDeleteJob([storyFile.localPath], TRANSIENT_CONVERSION_TTL_MS).catch(() => {});
          }
        } catch (storyErr) {
          logger.warn({ platform: pp.platform, error: storyErr }, 'Share to Story failed (main post succeeded)');
        }
      }

      // "First Comment" — auto-post a reply after the main post succeeds
      const firstComment = (post.platformSpecific as Record<string, unknown> | undefined)?._firstComment as string | undefined;
      const publishedId = result.postId || result.processingId;
      if (firstComment && publishedId && !result.processing) {
        try {
          const commentResult = await handler.publishComment(channelData, publishedId, firstComment);
          logger.info({ platform: pp.platform, success: commentResult.success, error: commentResult.error || undefined, publishedId }, 'First comment result');
          await recordFirstCommentResult(pp.postId, pp.platform, {
            status: commentResult.success ? 'posted' : 'failed',
            error: commentResult.success ? undefined : commentResult.error,
            at: new Date().toISOString(),
          }).catch(() => {});
        } catch (commentErr) {
          logger.warn({ platform: pp.platform, error: commentErr }, 'First comment failed (main post succeeded)');
          await recordFirstCommentResult(pp.postId, pp.platform, {
            status: 'failed',
            error: commentErr instanceof Error ? commentErr.message : String(commentErr),
            at: new Date().toISOString(),
          }).catch(() => {});
        }
      }
    } else {
      // Transient failure (rate limit / 5xx / network) with retry attempts left:
      // defer instead of failing. Auth failures are never transient, and an
      // unknown outcome (response lost after the request went out) is never
      // retried — the platform may have already created the post.
      const resultVerdict = result.authExpired === true ? 'reconnect' : classifyPublishError(result.error);
      if (resultVerdict === 'unknown') {
        await markUnconfirmed(result.error || 'The publish response was lost');
        return;
      }
      if (!finalAttempt && resultVerdict === 'retry') {
        return deferForRetry(result.error || 'Transient publishing failure');
      }
      if (finalAttempt && resultVerdict === 'retry' && hasAutoRepublishBudget(pp)) {
        return rescheduleForRetry(result.error || 'Transient publishing failure');
      }

      // A dead/revoked token: either the handler said so (e.g. Facebook 190/200)
      // or we hit a 401 the token-refresh retry above couldn't fix. Persist it on
      // the channel so the UI shows "Reconnect" and future posts fail fast (above)
      // instead of re-hitting the API and re-notifying for every post.
      const authExpired = result.authExpired === true || isReconnectError(result.error);
      if (authExpired && !channel.needsReconnect) {
        await db
          .update(channels)
          .set({ needsReconnect: true, updatedAt: new Date() })
          .where(eq(channels.id, channel.id));
        logger.warn({ platform: pp.platform, channelId: channel.id }, 'Channel flagged needsReconnect after auth failure');
      }

      await db
        .update(postPlatforms)
        .set({
          status: 'failed',
          errorMessage: result.error || 'Publishing failed',
        })
        .where(eq(postPlatforms.id, pp.id));

      // Build thumbnail URL for notification
      const firstMedia = resolvedMedia[0];
      const thumbnailUrl = firstMedia?.thumbnailPath
        ? getMediaPublicUrl(firstMedia.thumbnailPath)
        : firstMedia?.originalPath
          ? getMediaPublicUrl(firstMedia.originalPath)
          : null;

      // Send failure notification
      await addNotificationJob(
        post.userId,
        'post_failed',
        `Failed to publish to ${platformDisplayName(pp.platform)}`,
        result.error || 'Unknown error',
        {
          postId,
          platform: pp.platform,
          channelId: pp.channelId,
          thumbnailUrl,
          contentSnippet: (post.content || '').slice(0, 80),
        },
        post.organizationId,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ postId, platform: pp.platform, error: message }, 'Publish error');

    const thrownVerdict = classifyPublishError(message);
    if (thrownVerdict === 'unknown') {
      await markUnconfirmed(message);
      return;
    }
    if (!finalAttempt && thrownVerdict === 'retry') {
      return deferForRetry(message);
    }
    if (finalAttempt && thrownVerdict === 'retry' && hasAutoRepublishBudget(pp)) {
      return rescheduleForRetry(message);
    }

    // A handler that threw (rather than returned) on a dead token — e.g. fetchJson
    // surfacing an HTTP 401 — still flags the channel for reconnection. The
    // fast-fail at the top of this function then skips it on subsequent posts.
    if (isReconnectError(message)) {
      await db
        .update(channels)
        .set({ needsReconnect: true, updatedAt: new Date() })
        .where(eq(channels.id, pp.channelId));
    }

    await db
      .update(postPlatforms)
      .set({
        status: 'failed',
        errorMessage: message,
      })
      .where(eq(postPlatforms.id, pp.id));

    // Build thumbnail URL for notification
    const firstMedia = resolvedMedia[0];
    const thumbnailUrl = firstMedia?.thumbnailPath
      ? getMediaPublicUrl(firstMedia.thumbnailPath)
      : firstMedia?.originalPath
        ? getMediaPublicUrl(firstMedia.originalPath)
        : null;

    // Send failure notification
    await addNotificationJob(
      post.userId,
      'post_failed',
      `Failed to publish to ${platformDisplayName(pp.platform)}`,
      message,
      {
        postId,
        platform: pp.platform,
        channelId: pp.channelId,
        thumbnailUrl,
        contentSnippet: (post.content || '').slice(0, 80),
      },
      post.organizationId,
    );
  }
}

async function publishSingleThreadPlatform(
  pp: any,
  post: any,
  channelMap: Map<number, any>,
  mediaById: Map<number, any>,
  globalThreadParts: ThreadPart[],
  platformThreadParts: Record<string, ThreadPart[]>,
  postId: number,
  finalAttempt = true,
): Promise<'transient' | 'rescheduled' | void> {
  // Use platform-specific thread parts if available, else global
  const effectiveParts = platformThreadParts[pp.platform]?.length
    ? platformThreadParts[pp.platform]
    : globalThreadParts;

  // Reset to 'pending' for the retrying job, preserving thread resume state
  // (threadPostIds) so already-posted head segments are not re-posted.
  const deferThreadForRetry = async (errorMessage: string, resumePosts: unknown) => {
    await db
      .update(postPlatforms)
      .set({
        status: 'pending',
        errorMessage,
        threadPostIds: (Array.isArray(resumePosts) && resumePosts.length ? resumePosts : (pp.threadPostIds ?? null)) as any,
      })
      .where(eq(postPlatforms.id, pp.id));
    logger.warn({ postId, platform: pp.platform, error: errorMessage }, 'Transient thread publish failure — deferred for retry');
    return 'transient' as const;
  };

  // Final-attempt counterpart — see rescheduleForRetry in the single-post path.
  // Preserves thread resume state so the delayed re-publish resumes instead of
  // re-posting already-published head segments.
  const rescheduleThreadForRetry = async (errorMessage: string, resumePosts: unknown) => {
    await db
      .update(postPlatforms)
      .set({
        status: 'pending',
        errorMessage,
        retryCount: sql`${postPlatforms.retryCount} + 1`,
        threadPostIds: (Array.isArray(resumePosts) && resumePosts.length ? resumePosts : (pp.threadPostIds ?? null)) as any,
      })
      .where(eq(postPlatforms.id, pp.id));
    logger.warn(
      { postId, platform: pp.platform, attempt: (pp.retryCount ?? 0) + 1, error: errorMessage },
      'Transient thread failure on the final attempt — scheduling a delayed re-publish',
    );
    return 'rescheduled' as const;
  };

  // Unknown outcome: a segment's response was lost mid-flight — it may be live.
  // Terminal; preserves whatever resume state exists so a MANUAL retry (after
  // the user checks the account) still resumes instead of re-posting the head.
  const markThreadUnconfirmed = async (errorMessage: string, resumePosts: unknown) => {
    const friendly =
      `The thread was sent to ${platformDisplayName(pp.platform)} but we could not confirm every segment was published ` +
      `(${errorMessage}). Check your ${platformDisplayName(pp.platform)} account before retrying — ` +
      'publishing again could duplicate a segment.';
    await db
      .update(postPlatforms)
      .set({
        status: 'unconfirmed',
        errorMessage: friendly,
        threadPostIds: (Array.isArray(resumePosts) && resumePosts.length ? resumePosts : (pp.threadPostIds ?? null)) as any,
      })
      .where(eq(postPlatforms.id, pp.id));
    logger.warn({ postId, platform: pp.platform, error: errorMessage }, 'Thread publish outcome unknown — marked unconfirmed');
    await addNotificationJob(
      post.userId,
      'post_failed',
      `Couldn't confirm your ${platformDisplayName(pp.platform)} thread`,
      friendly,
      { postId, platform: pp.platform, channelId: pp.channelId, contentSnippet: (effectiveParts[0]?.content || '').slice(0, 80) },
      post.organizationId,
    );
  };

  const threadTempFiles: string[] = [];
  try {
    const channel = channelMap.get(pp.channelId);
    if (!channel) {
      await db
        .update(postPlatforms)
        .set({ status: 'failed', errorMessage: 'Channel not found' })
        .where(eq(postPlatforms.id, pp.id));
      return;
    }

    // Platform kill switch — hold the thread rather than failing it, preserving
    // any already-posted segments so the resume picks up where it left off.
    const threadAvailability = getPlatformAvailabilityFor(pp.platform, channel.accountType);
    if (!threadAvailability.canPublish) {
      return deferThreadForRetry(
        threadAvailability.message ??
          `${platformDisplayName(pp.platform)} is temporarily unavailable — this post is on hold and will publish automatically once it's back.`,
        pp.threadPostIds,
      );
    }

    /*
     * Pre-publish length check, the thread equivalent of the
     * validateForPlatform call on the single-post path — which a thread never
     * reached, so an over-long part went to the platform and was refused
     * part-way through, leaving segments already public.
     *
     * Only on a FRESH publish. On a resume some segments are already live and
     * the handler skips them; failing the whole platform then could reject a
     * thread that would otherwise finish.
     */
    if (!pp.threadPostIds?.length) {
      const lengthErrors = validateThreadPartLengths({
        postFormat: 'thread',
        threadParts: effectiveParts,
        platforms: [pp.platform],
        postTypeOverrides: post.postTypeOverrides as Record<string, string> | null,
      });
      if (lengthErrors.length > 0) {
        const errorMsg = lengthErrors.join('; ');
        logger.warn({ postId, platform: pp.platform, errors: lengthErrors }, 'Thread pre-publish validation failed');
        await db
          .update(postPlatforms)
          .set({ status: 'failed', errorMessage: errorMsg, publishedAt: new Date() })
          .where(eq(postPlatforms.id, pp.id));
        await addNotificationJob(
          post.userId,
          'post_failed',
          `Failed to publish thread to ${platformDisplayName(pp.platform)}`,
          errorMsg,
          { postId, platform: pp.platform, channelId: pp.channelId, contentSnippet: (effectiveParts[0]?.content || '').slice(0, 80) },
          post.organizationId,
        );
        return;
      }
    }

    const handler = getPlatformHandler(pp.platform as PlatformName);

    const channelData: ChannelData = {
      id: channel.id,
      platform: channel.platform as PlatformName,
      accountId: channel.accountId,
      accountName: channel.accountName,
      accountType: channel.accountType ?? undefined,
      accessToken: channel.accessToken ? decrypt(channel.accessToken) : '',
      refreshToken: channel.refreshToken ? decrypt(channel.refreshToken) : undefined,
      metadata: channel.metadata as Record<string, unknown>,
      organizationId: post.organizationId,
    };

    // Build segments with resolved media for this platform
    const segments = effectiveParts.map((part, idx) => {
      const partMedia: MediaFileData[] = (part.mediaFileIds || [])
        .map((id) => mediaById.get(id))
        .filter(Boolean)
        .map((f: any) => ({
          url: getMediaPublicUrl(f.originalPath),
          localPath: f.originalPath,
          mimeType: f.mimeType,
          width: f.width,
          height: f.height,
          duration: f.duration,
          sizeBytes: f.sizeBytes,
        }));

      return {
        sequence: idx,
        // Same jsonb trap as platform_content: only a string survives; a
        // truthy non-string would crash string handling in the handlers.
        content: typeof part.content === 'string' ? part.content : '',
        mediaUrls: partMedia.map((f) => f.url),
        mediaFiles: partMedia,
        postType: 'thread',
      } as PostData & { sequence: number };
    });

    // Push platforms read media bytes from disk — download R2 media to temp first.
    if (PUSH_PLATFORMS.has(pp.platform as PlatformName)) {
      const cache = new Map<string, string>();
      for (const seg of segments) {
        seg.mediaFiles = await materializeToLocal(seg.mediaFiles, cache, threadTempFiles, postId);
      }
    }

    // On a retry, threadPostIds holds the segments a prior partial run already posted; pass
    // them so the handler resumes instead of re-posting (and duplicating) the head segments.
    const result = await handler.publishThread(segments, channelData, pp.threadPostIds ?? undefined);

    if (result.success && result.posts && result.posts.length > 0) {
      await db
        .update(postPlatforms)
        .set({
          status: 'published',
          platformPostId: result.posts[0].postId,
          platformUrl: result.posts[0].url,
          threadPostIds: result.posts,
          publishedAt: new Date(),
          // Clear any transient error left by a deferred/rescheduled retry.
          errorMessage: null,
        })
        .where(eq(postPlatforms.id, pp.id));
    } else {
      const resultVerdict = result.authExpired === true ? 'reconnect' : classifyPublishError(result.error);
      if (resultVerdict === 'unknown') {
        await markThreadUnconfirmed(result.error || 'The publish response was lost', result.posts);
        return;
      }
      if (!finalAttempt && resultVerdict === 'retry') {
        return deferThreadForRetry(result.error || 'Transient thread publish failure', result.posts);
      }
      if (finalAttempt && resultVerdict === 'retry' && hasAutoRepublishBudget(pp)) {
        return rescheduleThreadForRetry(result.error || 'Transient thread publish failure', result.posts);
      }

      await db
        .update(postPlatforms)
        .set({
          status: 'failed',
          errorMessage: result.error || 'Thread publish failed',
          // A failure before any segment was (re)posted returns no posts — keep the prior
          // resume state instead of wiping it, or the next retry re-posts the head segments.
          threadPostIds: result.posts?.length ? result.posts : (pp.threadPostIds ?? null),
        })
        .where(eq(postPlatforms.id, pp.id));

      await addNotificationJob(
        post.userId,
        'post_failed',
        `Failed to publish thread to ${platformDisplayName(pp.platform)}`,
        result.error || 'Unknown error',
        { postId, platform: pp.platform, channelId: pp.channelId, contentSnippet: (effectiveParts[0]?.content || '').slice(0, 80) },
        post.organizationId,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ postId, platform: pp.platform, error: message }, 'Thread publish error');

    const thrownVerdict = classifyPublishError(message);
    if (thrownVerdict === 'unknown') {
      await markThreadUnconfirmed(message, null);
      return;
    }
    if (!finalAttempt && thrownVerdict === 'retry') {
      return deferThreadForRetry(message, null);
    }
    if (finalAttempt && thrownVerdict === 'retry' && hasAutoRepublishBudget(pp)) {
      return rescheduleThreadForRetry(message, null);
    }

    await db
      .update(postPlatforms)
      .set({ status: 'failed', errorMessage: message })
      .where(eq(postPlatforms.id, pp.id));

    await addNotificationJob(
      post.userId,
      'post_failed',
      `Failed to publish thread to ${platformDisplayName(pp.platform)}`,
      message,
      { postId, platform: pp.platform, channelId: pp.channelId, contentSnippet: (effectiveParts[0]?.content || '').slice(0, 80) },
      post.organizationId,
    );
  } finally {
    cleanupTempFiles(threadTempFiles);
  }
}
