/**
 * Context-aware notification action mapping. Failed posts must offer a real
 * retry + edit, token warnings a reconnect, and everything a delete — and the
 * mapping must tolerate old rows where only the client-mapped uiType survives.
 */
import { getNotificationActions } from '@components/notifications/NotificationActions';

const keys = (n: Parameters<typeof getNotificationActions>[0]) =>
  getNotificationActions(n).map((a) => a.key);

describe('getNotificationActions', () => {
  it('failed post with postId gets retry + edit + delete', () => {
    expect(keys({ rawType: 'post_failed', uiType: 'error', data: { postId: 12, platform: 'facebook' } }))
      .toEqual(['retry', 'edit', 'delete']);
  });

  it('failed post without postId gets only delete', () => {
    expect(keys({ rawType: 'post_failed', uiType: 'error', data: {} })).toEqual(['delete']);
  });

  it('legacy error row (no rawType) still gets retry + edit', () => {
    expect(keys({ uiType: 'error', data: { postId: 3 } })).toEqual(['retry', 'edit', 'delete']);
  });

  it.each(['token_expiring', 'token_expired'])('%s gets reconnect + delete', (rawType) => {
    expect(keys({ rawType, uiType: 'warning', data: { channelId: 5, platform: 'x' } }))
      .toEqual(['reconnect', 'delete']);
  });

  it('legacy warning row with channelId and no postId gets reconnect', () => {
    expect(keys({ uiType: 'warning', data: { channelId: 5 } })).toEqual(['reconnect', 'delete']);
  });

  it('info/system rows get only delete', () => {
    expect(keys({ rawType: 'system', uiType: 'info', data: {} })).toEqual(['delete']);
  });
});

export {};
