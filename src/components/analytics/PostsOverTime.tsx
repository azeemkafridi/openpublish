import { useApi } from '@lib/swr';
import { localDateStr, localDaysAgo, browserTz } from '@lib/dates';
import { PostsBarChart, type PostsBarChartDay } from './PostsBarChart';

interface SummaryData {
  byDay: PostsBarChartDay[];
}

function daysAgo(n: number): string {
  return localDaysAgo(n);
}

function today(): string {
  return localDateStr();
}

interface Props {
  /**
   * Window to chart. The Overview page passes its own last-30-days range so
   * both hit the SAME `/api/analytics/summary` key and SWR dedupes them into a
   * single request — previously this defaulted to a 29-day window and fired a
   * second, near-identical query on every dashboard load.
   */
  from?: string;
  to?: string;
}

/** Overview-page card: last-30-days posts-per-day chart (shared PostsBarChart). */
export default function PostsOverTime({ from: fromProp, to: toProp }: Props = {}) {
  const from = fromProp ?? daysAgo(30);
  const to = toProp ?? today();
  const { data, isLoading } = useApi<SummaryData>(
    `/api/analytics/summary?from=${from}&to=${to}&tz=${encodeURIComponent(browserTz())}`,
    { keepPreviousData: true },
  );

  const hasData = !!data?.byDay && data.byDay.length > 0;

  // Keep the card mounted at a stable height in every state. Returning null
  // while loading (and popping a ~200px card in afterwards) was one of the
  // overview's layout jumps — perceived as the page "flickering".
  return (
    <div className="card" style={{ padding: '20px', position: 'relative', minHeight: '220px' }}>
      <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--stone-800)', marginBottom: '12px' }}>
        Posts Over Time
      </h3>
      {hasData ? (
        <PostsBarChart data={data.byDay} from={from} to={to} />
      ) : (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)', margin: '48px 0', textAlign: 'center' }}>
          {isLoading ? 'Loading…' : 'No posts in this period yet.'}
        </p>
      )}
    </div>
  );
}
