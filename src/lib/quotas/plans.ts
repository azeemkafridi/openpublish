// openPublish is self-hosted: there are no paid tiers and no quotas.
// The PlanTier/PlanLimits shapes are kept so the rest of the codebase
// (written against them) type-checks unchanged; every tier resolves to
// the same unlimited limits.
import type { PlatformName } from '../platforms/types';
export type { PlatformName };

export type PlanTier = 'free' | 'pro' | 'business';

export interface PlanLimits {
  channels: number;
  channelsPerPlatform: number;
  postsPerDay: number;
  postsPerMonth: number;
  maxPendingScheduled: number;
  scheduledPerDay: number;
  mediaStorageMB: number;
  apiKeys: number;
  apiRequestsPerDay: number;
  webhooks: number;
  maxLabels: number;
  maxOrgMembers: number;
  excludedPlatforms: PlatformName[];
}

/** -1 = unlimited, 0 = disabled. Self-hosted: everything unlimited. */
const UNLIMITED: PlanLimits = {
  channels: -1,
  channelsPerPlatform: -1,
  postsPerDay: -1,
  postsPerMonth: -1,
  maxPendingScheduled: -1,
  scheduledPerDay: -1,
  mediaStorageMB: -1,
  apiKeys: -1,
  apiRequestsPerDay: -1,
  webhooks: -1,
  maxLabels: -1,
  maxOrgMembers: -1,
  excludedPlatforms: [],
};

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: UNLIMITED,
  pro: UNLIMITED,
  business: UNLIMITED,
};

export const PLAN_DISPLAY_NAMES: Record<PlanTier, string> = {
  free: 'Self-hosted',
  pro: 'Self-hosted',
  business: 'Self-hosted',
};

export function isUnlimited(value: number): boolean {
  return value === -1;
}

export function isDisabled(value: number): boolean {
  return value === 0;
}
