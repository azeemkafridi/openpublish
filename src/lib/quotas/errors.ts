import type { QuotaCheckResult } from './check';
import type { PlanTier } from './plans';

// Self-hosted openPublish never enforces quotas, so this response should be
// unreachable; it is kept because API routes reference it.
export function quotaExceededResponse(check: QuotaCheckResult, plan: PlanTier): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `Limit reached for ${check.resource.replace(/_/g, ' ')} (${check.current}/${check.limit}).`,
        code: check.limit === 0 ? 'FEATURE_DISABLED' : 'QUOTA_EXCEEDED',
        resource: check.resource,
        current: check.current,
        limit: check.limit,
        plan,
        upgrade: false,
      },
    }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}
