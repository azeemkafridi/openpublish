import { db } from '@lib/db';
import { activityLogs } from '@lib/db/schema';

interface LogActivityOptions {
  userId?: string;
  organizationId?: number;
  action: string;
  resource?: string;
  resourceId?: string | number;
  details?: Record<string, unknown>;
  level?: 'info' | 'warning' | 'error';
}

/**
 * Log an activity event. Fire-and-forget — does not block the caller.
 */
export function logActivity(opts: LogActivityOptions): void {
  db.insert(activityLogs)
    .values({
      userId: opts.userId ?? null,
      organizationId: opts.organizationId ?? null,
      action: opts.action,
      resource: opts.resource ?? opts.action.split('.')[0],
      resourceId: opts.resourceId != null ? String(opts.resourceId) : null,
      details: opts.details ?? null,
      level: opts.level ?? 'info',
    })
    .catch((err) => {
      console.error('[activity-log] Failed to write activity log:', err);
    });
}
