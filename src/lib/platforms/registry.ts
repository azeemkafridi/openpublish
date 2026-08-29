import type { PlatformName, PlatformConfig, PostTypeOption } from './types';
import { ALL_PLATFORMS, PLATFORM_DISPLAY_NAMES, PLATFORM_BRAND_COLORS } from './types';
import type { PlatformHandler } from './base';

const handlers = new Map<PlatformName, PlatformHandler>();

export function registerPlatform(handler: PlatformHandler): void {
  handlers.set(handler.name, handler);
}

export function getPlatformHandler(name: PlatformName): PlatformHandler {
  const handler = handlers.get(name);
  if (!handler) {
    throw new Error(`Platform handler not registered: ${name}`);
  }
  return handler;
}

export function getAllPlatforms(): PlatformHandler[] {
  return Array.from(handlers.values());
}

export function getPlatformConfig(name: PlatformName): PlatformConfig {
  return getPlatformHandler(name).config;
}

/**
 * Platform display metadata, served to the marketing site via /api/platforms.
 * Derived — this was a hand-written literal that drifted from the UI on two
 * counts: it spelled Bluesky "BlueSky" and used a different Instagram pink.
 */
export const PLATFORM_DISPLAY: Record<
  PlatformName,
  { displayName: string; color: string }
> = Object.fromEntries(
  ALL_PLATFORMS.map((p) => [p, { displayName: PLATFORM_DISPLAY_NAMES[p], color: PLATFORM_BRAND_COLORS[p] }]),
) as Record<PlatformName, { displayName: string; color: string }>;
