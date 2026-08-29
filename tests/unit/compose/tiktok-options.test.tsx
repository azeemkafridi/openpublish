/**
 * TikTok PlatformOptions UI tests.
 *
 * Tests the TikTok section of the PlatformOptions compose component against
 * TikTok's required UX (Content Sharing Guidelines):
 *   - Renders when TikTok channel is selected / not otherwise
 *   - Privacy dropdown has NO default and offers the creator's levels
 *   - Interaction toggles (Comment/Duet/Stitch) default to OFF
 *   - Commercial content disclosure flow + AI-generated content label
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlatformOptions, validatePlatformOptions } from '@/components/compose/PlatformOptions';
import type { SelectedChannel } from '@/components/compose/ChannelSelector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTikTokChannel(id = 1): SelectedChannel {
  return {
    channelId: id,
    platform: 'tiktok',
  };
}

function makeYouTubeChannel(id = 2): SelectedChannel {
  return {
    channelId: id,
    platform: 'youtube',
  };
}

async function getPrivacySelect(): Promise<HTMLSelectElement> {
  return await waitFor(() => {
    const s = screen
      .getAllByRole('combobox')
      .find((el) =>
        Array.from(el.querySelectorAll('option')).some((o) => o.textContent === 'Public'),
      ) as HTMLSelectElement | undefined;
    if (!s) throw new Error('privacy select not loaded yet');
    return s;
  });
}

const CREATOR_INFO = {
  nickname: 'Demo Creator',
  avatarUrl: '',
  privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoPostDurationSec: 600,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlatformOptions — TikTok section', () => {
  beforeEach(() => {
    // creator_info fetch — default to a successful lookup; the privacy options
    // come exclusively from this response (no hardcoded fallback).
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ info: CREATOR_INFO }),
    });
  });

  it('renders TikTok controls when TikTok channel selected', () => {
    const onChange = vi.fn();

    render(
      <PlatformOptions
        selectedChannels={[makeTikTokChannel()]}
        platformSpecific={{}}
        onChange={onChange}
      />,
    );

    // Privacy dropdown should be present
    expect(screen.getByText('Who can view this post')).toBeInTheDocument();

    // Interaction toggles
    expect(screen.getByText('Comment')).toBeInTheDocument();
    expect(screen.getByText('Duet')).toBeInTheDocument();
    expect(screen.getByText('Stitch')).toBeInTheDocument();

    // Content disclosure
    expect(screen.getByText('AI-generated content')).toBeInTheDocument();
    expect(screen.getByText('Disclose video content')).toBeInTheDocument();

    // Compliance declaration
    expect(screen.getByText('Music Usage Confirmation')).toBeInTheDocument();
  });

  it('does not render when no TikTok channel', () => {
    const onChange = vi.fn();

    const { container } = render(
      <PlatformOptions
        selectedChannels={[]}
        platformSpecific={{}}
        onChange={onChange}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('shows privacy dropdown with no default and the creator_info options', async () => {
    const onChange = vi.fn();

    render(
      <PlatformOptions
        selectedChannels={[makeTikTokChannel()]}
        platformSpecific={{}}
        onChange={onChange}
      />,
    );

    const privacySelect = await getPrivacySelect();
    expect(privacySelect).toBeDefined();

    // TikTok UX guideline: no default privacy — placeholder selected until user picks.
    expect(privacySelect.value).toBe('');

    const labels = Array.from(privacySelect.querySelectorAll('option')).map((o) => o.textContent);
    expect(labels).toContain('Public');
    expect(labels).toContain('Friends');
    expect(labels).toContain('Followers');
    expect(labels).toContain('Only me');
  });

  it('calls onChange when privacy level changes', async () => {
    const onChange = vi.fn();

    render(
      <PlatformOptions
        selectedChannels={[makeTikTokChannel()]}
        platformSpecific={{}}
        onChange={onChange}
      />,
    );

    fireEvent.change(await getPrivacySelect(), { target: { value: 'SELF_ONLY' } });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiktok: expect.objectContaining({
          privacyLevel: 'SELF_ONLY',
        }),
      }),
    );
  });

  it('interaction toggles default off and call onChange with correct values', () => {
    const onChange = vi.fn();

    render(
      <PlatformOptions
        selectedChannels={[makeTikTokChannel()]}
        platformSpecific={{}}
        onChange={onChange}
      />,
    );

    // TikTok UX guideline: interactions start unchecked (disabled).
    const commentsCheckbox = screen.getByText('Comment')
      .closest('label')!
      .querySelector('input')!;
    expect(commentsCheckbox.checked).toBe(false);

    // Check it (should set disableComment: false)
    fireEvent.click(commentsCheckbox);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiktok: expect.objectContaining({
          disableComment: false,
        }),
      }),
    );
  });

  it('AI disclosure checkbox calls onChange', () => {
    const onChange = vi.fn();

    render(
      <PlatformOptions
        selectedChannels={[makeTikTokChannel()]}
        platformSpecific={{}}
        onChange={onChange}
      />,
    );

    const aigcCheckbox = screen.getByText('AI-generated content')
      .closest('label')!
      .querySelector('input')!;

    fireEvent.click(aigcCheckbox);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiktok: expect.objectContaining({
          isAigc: true,
        }),
      }),
    );
  });

  it('commercial disclosure toggle reveals Your brand / Branded content and clears them when turned off', () => {
    const onChange = vi.fn();
    const disclosed = {
      privacyLevel: 'PUBLIC_TO_EVERYONE', disableDuet: true, disableStitch: true,
      disableComment: true, isAigc: false, discloseCommercial: true,
      brandContentToggle: true, brandOrganicToggle: true,
    };

    render(
      <PlatformOptions
        selectedChannels={[makeTikTokChannel()]}
        platformSpecific={{ tiktok: disclosed }}
        onChange={onChange}
      />,
    );

    expect(screen.getByText('Your brand')).toBeInTheDocument();
    expect(screen.getByText('Branded content')).toBeInTheDocument();
    // Both selected → paid partnership label + branded content policy declaration
    expect(screen.getByText(/labeled as "Paid partnership"/)).toBeInTheDocument();
    expect(screen.getByText('Branded Content Policy')).toBeInTheDocument();

    // Turning the toggle off clears both disclosure options
    const toggle = screen.getByText('Disclose video content')
      .closest('label')!
      .querySelector('input')!;
    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiktok: expect.objectContaining({
          discloseCommercial: false,
          brandContentToggle: false,
          brandOrganicToggle: false,
        }),
      }),
    );
  });

  it('renders alongside YouTube options when both selected', () => {
    const onChange = vi.fn();

    render(
      <PlatformOptions
        selectedChannels={[makeTikTokChannel(), makeYouTubeChannel()]}
        platformSpecific={{}}
        onChange={onChange}
      />,
    );

    // Both TikTok and YouTube should be visible
    expect(screen.getByText('Who can view this post')).toBeInTheDocument(); // TikTok
    expect(screen.getByText('Visibility')).toBeInTheDocument(); // YouTube
  });

  it('disables the privacy select and clears privacy when creator_info fails', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'TikTok is not accepting new posts from this account right now. Please try again later.' }),
    });
    const onChange = vi.fn();

    render(
      <PlatformOptions
        selectedChannels={[makeTikTokChannel()]}
        platformSpecific={{ tiktok: {
          privacyLevel: 'PUBLIC_TO_EVERYONE', disableDuet: true, disableStitch: true,
          disableComment: true, isAigc: false, brandContentToggle: false, brandOrganicToggle: false,
        } }}
        onChange={onChange}
      />,
    );

    await screen.findByText(/not accepting new posts/);

    // A previously picked privacy level is cleared so validation keeps blocking.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tiktok: expect.objectContaining({ privacyLevel: '' }) }),
    );

    // No hardcoded privacy options — the select is disabled and empty of real options.
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const privacy = selects.find((s) => Array.from(s.querySelectorAll('option')).some((o) => o.textContent?.startsWith('Select privacy')))!;
    expect(privacy.disabled).toBe(true);
    expect(privacy.querySelectorAll('option').length).toBe(1); // placeholder only
  });

  it('photo posts show an off-by-default "Add recommended music" toggle', async () => {
    const onChange = vi.fn();

    render(
      <PlatformOptions
        selectedChannels={[makeTikTokChannel()]}
        platformSpecific={{}}
        onChange={onChange}
        postTypes={{ tiktok: 'photo_slideshow' }}
      />,
    );

    const musicCheckbox = screen.getByText('Add recommended music')
      .closest('label')!
      .querySelector('input')!;
    expect(musicCheckbox.checked).toBe(false);

    fireEvent.click(musicCheckbox);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tiktok: expect.objectContaining({ autoAddMusic: true }) }),
    );
  });

  it('video posts do not show the music toggle', () => {
    render(
      <PlatformOptions
        selectedChannels={[makeTikTokChannel()]}
        platformSpecific={{}}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText('Add recommended music')).not.toBeInTheDocument();
  });
});

describe('validatePlatformOptions — TikTok extras', () => {
  const channels = [makeTikTokChannel()];
  const baseTt = {
    privacyLevel: 'PUBLIC_TO_EVERYONE', disableDuet: true, disableStitch: true,
    disableComment: true, isAigc: false, brandContentToggle: false, brandOrganicToggle: false,
  };

  it('requires a caption (TikTok title) when extras are provided', () => {
    const errs = validatePlatformOptions(channels, { tiktok: baseTt }, undefined, { content: '  ' });
    expect(errs.some((e) => e.includes('TikTok requires a title'))).toBe(true);

    const ok = validatePlatformOptions(channels, { tiktok: baseTt }, undefined, { content: 'My caption' });
    expect(ok.some((e) => e.includes('TikTok requires a title'))).toBe(false);
  });

  it('rejects videos longer than the creator max duration', () => {
    const tt = { ...baseTt, maxVideoDurationSec: 60 };
    const errs = validatePlatformOptions(channels, { tiktok: tt }, undefined, { content: 'x', videoDurationSec: 90 });
    expect(errs.some((e) => e.includes('allows up to 60s'))).toBe(true);

    const ok = validatePlatformOptions(channels, { tiktok: tt }, undefined, { content: 'x', videoDurationSec: 45 });
    expect(ok.some((e) => e.includes('allows up to'))).toBe(false);
  });
});
