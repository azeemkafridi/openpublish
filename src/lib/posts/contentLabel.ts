/**
 * Placeholder text for a post whose `content` (the shared caption/body) is empty.
 *
 * The retention sweep nulls out content only on posts older than the 3-month
 * window. So an empty body on a RECENT post is not "removed" content — it's a
 * legitimately title-only or media-only post (e.g. a YouTube video where only the
 * per-platform Title was set, or a Pinterest pin). Only label it "removed" when
 * the post is actually old enough to have been swept; otherwise it reads as data
 * loss that never happened.
 */
const RETENTION_DAYS = 90;

export function emptyContentLabel(
  status: string | null | undefined,
  createdAt: string | Date | null | undefined,
): string {
  const isPublished = status === 'published' || status === 'partial';
  const created = createdAt ? new Date(createdAt).getTime() : 0;
  const ageDays = created ? (Date.now() - created) / (1000 * 60 * 60 * 24) : 0;

  if (isPublished && ageDays >= RETENTION_DAYS) {
    return '(Content removed after 3 months)';
  }
  return '(No text content)';
}
