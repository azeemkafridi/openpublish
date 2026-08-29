import type { SelectedChannel, Platform } from './ChannelSelector';
import type { MediaFile } from './MediaUploader';
import { PlatformIcon } from '@components/channels/PlatformIcon';
import { platformDisplayName } from '@lib/platforms/types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PostTypeOverrides {
  [channelId: number]: string;
}

export interface PostTypeSelectorProps {
  selectedChannels: SelectedChannel[];
  postTypeOverrides: PostTypeOverrides;
  mediaFiles: MediaFile[];
  onChange: (overrides: PostTypeOverrides) => void;
}

/* ------------------------------------------------------------------ */
/*  Platform post-type config                                          */
/* ------------------------------------------------------------------ */

export interface PostTypeOption {
  value: string;
  label: string;
  mediaRequired?: boolean;
  maxMedia?: number;
  minMedia?: number;
  allowedMediaTypes?: ('image' | 'video')[];
}

export const PLATFORM_POST_TYPES: Partial<Record<Platform, PostTypeOption[]>> = {
  facebook: [
    { value: 'post', label: 'Post', maxMedia: 10, allowedMediaTypes: ['image'] },
    { value: 'video', label: 'Video', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
    { value: 'reel', label: 'Reel', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
    { value: 'story', label: 'Story', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['image', 'video'] },
    { value: 'carousel', label: 'Carousel', mediaRequired: true, maxMedia: 10, minMedia: 2, allowedMediaTypes: ['image'] },
  ],
  instagram: [
    { value: 'feed_photo', label: 'Feed Photo', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['image'] },
    { value: 'feed_video', label: 'Feed Video', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
    { value: 'reel', label: 'Reel', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
    { value: 'story', label: 'Story', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['image', 'video'] },
    { value: 'carousel', label: 'Carousel', mediaRequired: true, maxMedia: 10, minMedia: 2, allowedMediaTypes: ['image', 'video'] },
  ],
  x: [
    { value: 'tweet', label: 'Tweet', maxMedia: 4, allowedMediaTypes: ['image'] },
    { value: 'video', label: 'Video', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
    { value: 'thread', label: 'Thread', maxMedia: 4, allowedMediaTypes: ['image'] },
  ],
  tiktok: [
    { value: 'video', label: 'Video', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
    { value: 'photo_slideshow', label: 'Photo Slideshow', mediaRequired: true, maxMedia: 35, minMedia: 2, allowedMediaTypes: ['image'] },
  ],
  youtube: [
    { value: 'video', label: 'Video', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
    { value: 'short', label: 'Short', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
  ],
  threads: [
    { value: 'text', label: 'Text', mediaRequired: false, maxMedia: 0 },
    { value: 'image', label: 'Image', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['image'] },
    { value: 'video', label: 'Video', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
    { value: 'carousel', label: 'Carousel', mediaRequired: true, maxMedia: 20, minMedia: 2, allowedMediaTypes: ['image', 'video'] },
    { value: 'thread', label: 'Thread', maxMedia: 1, allowedMediaTypes: ['image', 'video'] },
  ],
  bluesky: [
    { value: 'post', label: 'Post', maxMedia: 4, allowedMediaTypes: ['image'] },
    { value: 'video', label: 'Video', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
    { value: 'thread', label: 'Thread', maxMedia: 4, allowedMediaTypes: ['image'] },
  ],
  pinterest: [
    { value: 'pin', label: 'Pin', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['image'] },
    { value: 'video_pin', label: 'Video Pin', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
    { value: 'carousel', label: 'Carousel', mediaRequired: true, maxMedia: 5, minMedia: 2, allowedMediaTypes: ['image'] },
  ],
  gmb: [
    { value: 'post', label: 'Post', maxMedia: 1, allowedMediaTypes: ['image'] },
  ],
  linkedin: [
    { value: 'post', label: 'Post', maxMedia: 1, allowedMediaTypes: ['image'] },
    { value: 'multi_image', label: 'Gallery', mediaRequired: true, maxMedia: 20, minMedia: 2, allowedMediaTypes: ['image'] },
    { value: 'pdf_carousel', label: 'PDF Carousel', mediaRequired: true, maxMedia: 20, minMedia: 2, allowedMediaTypes: ['image'] },
    { value: 'article', label: 'Article', maxMedia: 1, allowedMediaTypes: ['image'] },
  ],
  mastodon: [
    { value: 'post', label: 'Post', maxMedia: 4, allowedMediaTypes: ['image', 'video'] },
    { value: 'thread', label: 'Thread', maxMedia: 4, allowedMediaTypes: ['image'] },
  ],
  reddit: [
    { value: 'post', label: 'Post', maxMedia: 1, allowedMediaTypes: ['image', 'video'] },
  ],
  discord: [
    { value: 'post', label: 'Message', maxMedia: 10, allowedMediaTypes: ['image', 'video'] },
  ],
  telegram: [
    { value: 'post', label: 'Post', maxMedia: 10, allowedMediaTypes: ['image', 'video'] },
  ],
  tumblr: [
    { value: 'post', label: 'Post', maxMedia: 30, allowedMediaTypes: ['image', 'video'] },
  ],
  snapchat: [
    { value: 'story', label: 'Story', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['image', 'video'] },
    { value: 'saved_story', label: 'Saved Story', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['image', 'video'] },
    { value: 'spotlight', label: 'Spotlight', mediaRequired: true, maxMedia: 1, allowedMediaTypes: ['video'] },
  ],
};

export const PLATFORM_DEFAULTS: Partial<Record<Platform, string>> = {
  facebook: 'post',
  instagram: 'feed_photo',
  x: 'tweet',
  tiktok: 'video',
  youtube: 'video',
  threads: 'text',
  bluesky: 'post',
  pinterest: 'pin',
  gmb: 'post',
  linkedin: 'post',
  mastodon: 'post',
  reddit: 'post',
  discord: 'post',
  telegram: 'post',
  tumblr: 'post',
  snapchat: 'story',
};

/* ------------------------------------------------------------------ */
/*  Validation helper                                                  */
/* ------------------------------------------------------------------ */

export function getMediaWarning(
  postType: PostTypeOption | undefined,
  mediaFiles: MediaFile[],
): string | null {
  if (!postType) return null;

  const count = mediaFiles.length;
  const hasImages = mediaFiles.some((f) => (f.mimeType ?? '').startsWith('image'));
  const hasVideos = mediaFiles.some((f) => (f.mimeType ?? '').startsWith('video'));

  // No media when required
  if (postType.mediaRequired && count === 0) {
    return `${postType.label} requires media`;
  }

  // Too many media
  if (postType.maxMedia !== undefined && count > postType.maxMedia) {
    if (postType.maxMedia === 0) return `${postType.label} does not support media`;
    return `${postType.label} supports up to ${postType.maxMedia} file${postType.maxMedia > 1 ? 's' : ''}`;
  }

  // Too few (carousels)
  if (postType.minMedia && count > 0 && count < postType.minMedia) {
    return `${postType.label} requires at least ${postType.minMedia} files`;
  }

  // Wrong media type
  if (postType.allowedMediaTypes && count > 0) {
    const allowsImage = postType.allowedMediaTypes.includes('image');
    const allowsVideo = postType.allowedMediaTypes.includes('video');

    if (hasImages && !allowsImage) {
      return `${postType.label} requires video. Images are not supported.`;
    }
    if (hasVideos && !allowsVideo) {
      return `${postType.label} requires images. Videos are not supported.`;
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function PostTypeSelector({
  selectedChannels,
  postTypeOverrides,
  mediaFiles,
  onChange,
}: PostTypeSelectorProps) {
  // Only show channels whose platform has multiple post types
  const applicableChannels = selectedChannels.filter(
    (ch) => {
      const opts = PLATFORM_POST_TYPES[ch.platform];
      return opts !== undefined && opts.length > 1;
    },
  );

  if (applicableChannels.length === 0) return null;

  const getTypeForChannel = (channelId: number, platform: Platform): string =>
    postTypeOverrides[channelId] ?? PLATFORM_DEFAULTS[platform] ?? '';

  const handleChange = (channelId: number, value: string) => {
    onChange({ ...postTypeOverrides, [channelId]: value });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <label className="label" style={{ marginBottom: 0 }}>
        Post type
      </label>

      {applicableChannels.map((ch) => {
        const options = PLATFORM_POST_TYPES[ch.platform]!;
        const currentValue = getTypeForChannel(ch.channelId, ch.platform);
        const currentOption = options.find((o) => o.value === currentValue);
        const warning = getMediaWarning(currentOption, mediaFiles);

        return (
          <div key={ch.channelId} style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 14px',
                borderRadius: warning ? 'var(--radius-md) var(--radius-md) 0 0' : 'var(--radius-md)',
                background: 'var(--stone-100)',
              }}
            >
              <PlatformIcon platform={ch.platform} size="sm" />

              <span
                style={{
                  flex: 1,
                  fontSize: 'var(--text-sm)',
                  fontWeight: 'var(--weight-medium)' as any,
                  color: 'var(--stone-700)',
                }}
              >
                {platformDisplayName(ch.platform)}
              </span>

              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {options.map((opt) => {
                  const active = currentValue === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handleChange(ch.channelId, opt.value)}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 'var(--radius-pill)',
                        border: 'none',
                        background: active ? 'var(--surface-main)' : 'transparent',
                        color: active ? 'var(--stone-900)' : 'var(--stone-600)',
                        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        fontSize: 'var(--text-xs)',
                        fontWeight: active ? ('var(--weight-semibold)' as any) : ('var(--weight-medium)' as any),
                        cursor: 'pointer',
                        transition: 'all var(--transition-fast)',
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Media validation warning */}
            {warning && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 14px',
                  borderRadius: '0 0 var(--radius-md) var(--radius-md)',
                  background: 'var(--color-warning-bg)',
                  fontSize: 'var(--text-xs)',
                  color: '#92400E',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="6" r="5" />
                  <line x1="6" y1="4" x2="6" y2="6.5" />
                  <circle cx="6" cy="8.5" r="0.5" fill="currentColor" />
                </svg>
                {warning}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
