import { describe, it, expect } from 'vitest';
import { channelProfileUrl } from '@/lib/platforms/profile-urls';

describe('channelProfileUrl', () => {
  it('builds handle-based URLs and strips a leading @', () => {
    expect(channelProfileUrl('x', '@jack', 'id1')).toBe('https://x.com/jack');
    expect(channelProfileUrl('tiktok', 'creator', 'id2')).toBe('https://www.tiktok.com/@creator');
    expect(channelProfileUrl('instagram', 'someone', 'id3')).toBe('https://www.instagram.com/someone');
    expect(channelProfileUrl('threads', '@user', 'id4')).toBe('https://www.threads.net/@user');
    expect(channelProfileUrl('bluesky', 'name.bsky.social', 'id5')).toBe('https://bsky.app/profile/name.bsky.social');
    expect(channelProfileUrl('pinterest', 'pinner', 'id6')).toBe('https://www.pinterest.com/pinner');
  });

  it('uses the account id for Facebook pages and YouTube channels', () => {
    expect(channelProfileUrl('facebook', 'My Page', '1234567890')).toBe('https://www.facebook.com/1234567890');
    expect(channelProfileUrl('youtube', 'My Channel', 'UCabc123')).toBe('https://www.youtube.com/channel/UCabc123');
  });

  it('returns null for platforms without a reliable public URL', () => {
    expect(channelProfileUrl('linkedin', 'someone', 'urn:li:123')).toBeNull();
    expect(channelProfileUrl('gmb', 'A Business', 'loc1')).toBeNull();
    expect(channelProfileUrl('mastodon', 'user', 'id')).toBeNull();
  });

  it('returns null when the needed identifier is missing', () => {
    expect(channelProfileUrl('x', '', 'id')).toBeNull();
    expect(channelProfileUrl('x', null, null)).toBeNull();
    expect(channelProfileUrl('facebook', 'Page', null)).toBeNull();
  });
});
