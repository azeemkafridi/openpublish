import { useState, type CSSProperties } from 'react';
import { PlatformIcon } from '../channels/PlatformIcon';
import { platformDisplayName, PLATFORM_BRAND_COLORS } from '@lib/platforms/types';

export type Platform =
  | 'facebook' | 'instagram' | 'x' | 'tiktok' | 'youtube'
  | 'threads' | 'bluesky' | 'pinterest' | 'gmb' | 'linkedin'
  | 'mastodon' | 'reddit' | 'discord' | 'telegram' | 'tumblr' | 'snapchat';

export interface LinkPreviewData {
  title: string;
  description: string;
  image: string;
  siteName: string;
  domain: string;
  url: string;
}

export interface ThreadPartData {
  content: string;
  mediaFileIds: number[];
}

export interface PreviewData {
  content: string;
  title?: string;
  platforms: Platform[];
  mediaUrl: string | null;
  mediaUrls?: string[];
  mediaType: 'image' | 'video' | null;
  postTypes?: Record<string, string>;
  linkPreview?: LinkPreviewData | null;
  mediaDuration?: number | null;
  threadParts?: ThreadPartData[];
  activePlatform?: Platform | null;
  platformContent?: Record<string, string>;
  /** Hide the built-in "PREVIEW" header + platform dropdown (when the parent supplies its own switcher). */
  hideHeader?: boolean;
  /** Real engagement for the active platform. When set, the mockup renders live counts. */
  metrics?: PreviewMetrics | null;
  /** GMB call-to-action (the only structured link surface GMB has — no link cards). */
  gmbCta?: { ctaType?: string; ctaUrl?: string } | null;
  /**
   * Real comments, rendered inside the card under the action bar the way the
   * network shows them. Only the skins that have a comment surface accept it
   * (Facebook, Instagram, X, LinkedIn, YouTube) — see PreviewComments.
   */
  commentsSlot?: React.ReactNode;
}

export interface PreviewMetrics {
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  videoViews: number;
}

/** Brand accents, canonical in lib/platforms/types.ts. This was a 14-entry copy
 * with its own Bluesky and Telegram blues and no Tumblr — Tumblr's dot rendered
 * grey. */
const PLATFORM_COLORS: Record<string, string> = PLATFORM_BRAND_COLORS;

function truncate(text: string, max: number) {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

/**
 * X (Twitter) hides a trailing URL once it renders as a link card, showing only
 * the card. Strip the card's URL when it sits at the end of the text so the X
 * mockup matches. Other platforms keep the URL text alongside the card.
 */
function stripTrailingUrl(content: string, url: string): string {
  const trimmed = content.replace(/\s+$/, '');
  if (url && trimmed.endsWith(url)) {
    return trimmed.slice(0, trimmed.length - url.length).replace(/\s+$/, '');
  }
  // Fall back to stripping any trailing bare URL token.
  return content.replace(/\s*https?:\/\/\S+\s*$/i, '').replace(/\s+$/, '');
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Compact engagement count for in-mockup labels: 1285 -> "1.3K", 94 -> "94". */
function fmtCount(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(v);
}

/* ------------------------------------------------------------------ */
/*  SVG Icon library — accurate per-platform icons                     */
/* ------------------------------------------------------------------ */

const icons = {
  // ── Instagram icons (Publer: 24×24, viewBox 0 0 48 48, fill #262626) ──
  igHeart: <svg width="24" height="24" viewBox="0 0 48 48" fill="#262626"><path clipRule="evenodd" d="M34.3 3.5C27.2 3.5 24 8.8 24 8.8s-3.2-5.3-10.3-5.3C6.4 3.5.5 9.9.5 17.8s6.1 12.4 12.2 17.8c9.2 8.2 9.8 8.9 11.3 8.9s2.1-.7 11.3-8.9c6.2-5.5 12.2-10 12.2-17.8 0-7.9-5.9-14.3-13.2-14.3zm-1 29.8c-5.4 4.8-8.3 7.5-9.3 8.1-1-.7-4.6-3.9-9.3-8.1-5.5-4.9-11.2-9-11.2-15.6 0-6.2 4.6-11.3 10.2-11.3 4.1 0 6.3 2 7.9 4.2 3.6 5.1 1.2 5.1 4.8 0 1.6-2.2 3.8-4.2 7.9-4.2 5.6 0 10.2 5.1 10.2 11.3 0 6.7-5.7 10.8-11.2 15.6z" fillRule="evenodd" /></svg>,
  igComment: <svg width="24" height="24" viewBox="0 0 48 48" fill="#262626"><path clipRule="evenodd" d="M47.5 46.1l-2.8-11c1.8-3.3 2.8-7.1 2.8-11.1C47.5 11 37 .5 24 .5S.5 11 .5 24 11 47.5 24 47.5c4 0 7.8-1 11.1-2.8l11 2.8c.8.2 1.6-.6 1.4-1.4zm-3-22.1c0 4-1 7-2.6 10-.2.4-.3.9-.2 1.4l2.1 8.4-8.3-2.1c-.5-.1-1-.1-1.4.2-1.8 1-5.2 2.6-10 2.6-11.4 0-20.6-9.2-20.6-20.5S12.7 3.5 24 3.5 44.5 12.7 44.5 24z" fillRule="evenodd" /></svg>,
  igShare: <svg width="24" height="24" viewBox="0 0 48 48" fill="#262626"><path d="M46.5 3.5h-45C.6 3.5.2 4.6.8 5.2l16 15.8 5.5 22.8c.2.9 1.4 1 1.8.3L47.4 5c.4-.7-.1-1.5-.9-1.5zm-40.1 3h33.5L19.1 18c-.4.2-.9.1-1.2-.2L6.4 6.5zm17.7 31.8l-4-16.6c-.1-.4.1-.9.5-1.1L41.5 9 24.1 38.3z" /></svg>,
  igSave: <svg width="24" height="24" viewBox="0 0 48 48" fill="#262626"><path d="M43.5 48c-.4 0-.8-.2-1.1-.4L24 29 5.6 47.6c-.4.4-1.1.6-1.6.3-.6-.2-1-.8-1-1.4v-45C3 .7 3.7 0 4.5 0h39c.8 0 1.5.7 1.5 1.5v45c0 .6-.4 1.2-.9 1.4-.2.1-.4.1-.6.1zM24 26c.8 0 1.6.3 2.2.9l15.8 16V3H6v39.9l15.8-16c.6-.6 1.4-.9 2.2-.9z" /></svg>,

  // ── Facebook icons (Publer: 20×20, viewBox 0 0 20 20, stroke #606770) ──
  fbLike: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" fillRule="evenodd"><path d="M2,17 L2,9 C2,8.448 2.448,8 3,8 L6,8 C6.552,8 7,8.448 7,9 L7,17 C7,17.552 6.552,18 6,18 L3,18 C2.448,18 2,17.552 2,17 Z" stroke="#606770" /><path d="M7,10 L7.861,9.09 C8.553,7.977 9.056,6.807 9.369,5.579 C9.558,4.836 9.525,2.593 9.785,2.443 C10.766,1.876 11.403,1.829 12.105,2.443 C12.241,2.532 13.212,3.579 13.42,4.324 C13.56,4.821 13.735,6.123 13.709,7.201 L17.325,7.201 C17.494,7.201 17.659,7.251 17.8,7.343 C18.429,7.759 18.744,8.226 18.744,8.744 C18.744,9.323 18.67,9.846 18.523,10.312 C18.841,10.696 19,11.149 19,11.671 C19,12.194 18.693,12.71 18.078,13.221 C18.148,13.777 18.104,14.263 17.949,14.679 C17.793,15.094 17.414,15.459 16.813,15.774 C16.8,16.166 16.758,16.499 16.685,16.771 C16.624,17 16.383,17.325 15.963,17.748 C15.802,17.909 15.583,18 15.354,18 L8.622,18 C8.3,18 7.998,17.845 7.81,17.583 L7,16.457 L7,10 Z" stroke="#606770" /></svg>,
  fbComment: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" fillRule="evenodd"><path d="M6.688,18 L6.394,18 L6.394,14.748 L5,14.748 C3.343,14.748 2,13.404 2,11.748 L2,5 C2,3.343 3.343,2 5,2 L15,2 C16.657,2 18,3.343 18,5 L18,11.748 C18,13.404 16.657,14.748 15,14.748 L10,14.748 L6.688,18 Z" stroke="#606770" /></svg>,
  fbShare: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" fillRule="evenodd"><path d="M2,17.874 C2.212,13.89 3.07,11.169 4.576,9.71 C6.098,8.235 8.056,7.475 10.452,7.428 L10.452,3.32 C10.452,3.143 10.595,3 10.772,3 C10.977,3 11.173,3.083 11.315,3.23 L17.517,9.628 C17.901,10.024 17.891,10.657 17.495,11.042 L11.116,17.117 C11.046,17.184 10.967,17.24 10.88,17.284 L10.731,17.36 C10.636,17.408 10.521,17.371 10.473,17.276 C10.459,17.249 10.452,17.219 10.452,17.189 L10.452,12.895 C8.736,12.788 7.26,13.127 6.022,13.912 C4.785,14.697 3.526,16.059 2.245,18 L2.12,18 C2.054,18 2,17.946 2,17.88 Z" stroke="#606770" /></svg>,
  fbDots: <svg width="16" height="4" viewBox="0 0 100 26" fill="#5f6670"><circle cx="13" cy="13" r="12.3" /><circle cx="50" cy="13" r="12.3" /><circle cx="87" cy="13" r="12.3" /></svg>,

  // ── X / Twitter icons (Publer: 22.5×22.5, viewBox 0 0 24 24, fill #536371) ──
  xReply: <svg width="22.5" height="22.5" viewBox="0 0 24 24"><path fill="#536371" d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z" /></svg>,
  xRepost: <svg width="22.5" height="22.5" viewBox="0 0 24 24"><path fill="#536371" d="m4.5,3.88l4.432,4.14l-1.364,1.46l-2.068,-1.93l0,8.45c0,1.1 0.896,2 2,2l5.5,0l0,2l-5.5,0c-2.209,0 -4,-1.79 -4,-4l0,-8.45l-2.068,1.93l-1.364,-1.46l4.432,-4.14zm12,2.12l-5.5,0l0,-2l5.5,0c2.209,0 4,1.79 4,4l0,8.45l2.068,-1.93l1.364,1.46l-4.432,4.14l-4.432,-4.14l1.364,-1.46l2.068,1.93l0,-8.45c0,-1.1 -0.896,-2 -2,-2z" /></svg>,
  xHeart: <svg width="22.5" height="22.5" viewBox="0 0 24 24"><path fill="#536371" d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z" /></svg>,
  xBookmark: <svg width="22.5" height="22.5" viewBox="0 0 24 24"><path fill="#536371" d="m4,4.5c0,-1.38 1.119,-2.5 2.5,-2.5l11,0c1.381,0 2.5,1.12 2.5,2.5l0,18.44l-8,-5.71l-8,5.71l0,-18.44zm2.5,-0.5c-0.276,0 -0.5,0.22 -0.5,0.5l0,14.56l6,-4.29l6,4.29l0,-14.56c0,-0.28 -0.224,-0.5 -0.5,-0.5l-11,0z" /></svg>,
  xShare: <svg width="22.5" height="22.5" viewBox="0 0 24 24"><path fill="#536371" d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z" /></svg>,
  xDots: <svg width="18.75" height="18.75" viewBox="0 0 24 24"><path fill="#536371" d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z" /></svg>,

  // ── Threads icons (Publer: 20×20, inline SVGs, stroke-based, color #999) ──
  thHeart: <svg width="20" height="20" viewBox="0 0 24 24" fill="transparent" stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>,
  thReply: <svg width="20" height="20" viewBox="0 0 24 24" fill="transparent" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
  thRepost: <svg width="20" height="20" viewBox="0 0 24 24" fill="transparent" stroke="currentColor" strokeWidth="2"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>,
  thShare: <svg width="20" height="20" viewBox="0 0 24 24" fill="transparent" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>,

  // ── Bluesky icons (Publer: ~18×18, fill #6F869F) ──
  bsComment: <svg width="18" height="18" viewBox="0 0 28 26" fill="#6F869F"><path fillRule="evenodd" clipRule="evenodd" d="M0.669 4C0.669 2.939 1.091 1.922 1.841 1.172C2.591 0.421 3.609 0 4.669 0H23.336C24.397 0 25.414 0.421 26.165 1.172C26.915 1.922 27.336 2.939 27.336 4V17.333C27.336 18.394 26.915 19.412 26.165 20.162C25.414 20.912 24.397 21.333 23.336 21.333H14.373L8.024 25.144C7.822 25.266 7.59 25.332 7.354 25.335C7.118 25.338 6.885 25.279 6.679 25.162C6.474 25.046 6.303 24.877 6.184 24.673C6.065 24.469 6.002 24.236 6.003 24V21.333H4.669C3.609 21.333 2.591 20.912 1.841 20.162C1.091 19.412 0.669 18.394 0.669 17.333V4ZM4.669 2.667C4.316 2.667 3.977 2.807 3.727 3.057C3.477 3.307 3.336 3.646 3.336 4V17.333C3.336 17.687 3.477 18.026 3.727 18.276C3.977 18.526 4.316 18.667 4.669 18.667H7.336C7.69 18.667 8.029 18.807 8.279 19.057C8.529 19.307 8.669 19.646 8.669 20V21.645L13.317 18.856C13.525 18.732 13.761 18.667 14.003 18.667H23.336C23.69 18.667 24.029 18.526 24.279 18.276C24.529 18.026 24.669 17.687 24.669 17.333V4C24.669 3.646 24.529 3.307 24.279 3.057C24.029 2.807 23.69 2.667 23.336 2.667H4.669Z" /></svg>,
  // The art is 24 wide x 27 tall, so a 24x28 viewBox rendered at 18x21 made
  // this the only non-square icon in Bluesky's action row — 3px taller than
  // its siblings, which read as the bottom being cut off. Pad the viewBox to
  // a 28x28 square (x offset -2 centres the art) and render it 18x18 like the rest.
  bsRepost: <svg width="18" height="18" viewBox="-2 0 28 28" fill="#6F869F"><path fillRule="evenodd" clipRule="evenodd" d="M19.943 1.057a1.333 1.333 0 00-1.886 0l-.057.057L19.781 4.667H4C2.939 4.667 1.922 5.088 1.172 5.838.421 6.588 0 7.606 0 8.667v4c0 .736.597 1.333 1.333 1.333.737 0 1.334-.597 1.334-1.333v-4c0-.354.14-.693.39-.943.25-.25.59-.39.943-.39h15.781l-1.724 1.723a1.333 1.333 0 001.886 1.886l3.293-3.294a1.333 1.333 0 000-1.886l-3.293-3.293zM22.667 14c.736 0 1.333.597 1.333 1.333v4c0 1.061-.421 2.079-1.172 2.829-.75.75-1.767 1.171-2.828 1.171H4.219l1.724 1.724a1.333 1.333 0 01-1.886 1.886L.764 23.649a1.333 1.333 0 010-1.886l3.293-3.294a1.333 1.333 0 011.886 1.886L4.219 22.08H20c.354 0 .693-.141.943-.391s.39-.59.39-.943v-4c0-.736.597-1.333 1.334-1.333z" /></svg>,
  bsHeart: <svg width="18" height="18" viewBox="0 0 28 25" fill="#6F869F"><path fillRule="evenodd" clipRule="evenodd" d="M20.312 2.789C18.662 2.421 16.702 2.852 14.95 4.629a1.333 1.333 0 01-1.9 0C11.299 2.851 9.339 2.42 7.688 2.788 6.004 3.164 4.516 4.396 3.795 6.196 2.44 9.575 3.67 15.788 14 21.799c10.33-6.011 11.56-12.224 10.206-15.6-.722-1.801-2.21-3.034-3.894-3.41zM26.682 5.205C28.82 10.539 26.023 18.125 14.652 24.499a1.333 1.333 0 01-1.304 0C1.978 18.124-.82 10.537 1.32 5.204 2.359 2.615 4.539.759 7.11.185c2.262-.504 4.736.004 6.892 1.715C16.158.189 18.631-.319 20.895.185c2.569.574 4.749 2.431 5.787 5.02z" /></svg>,
  bsShare: <svg width="18" height="18" viewBox="0 0 24 24" fill="#6F869F"><path fillRule="evenodd" clipRule="evenodd" d="M12.943.39A1.333 1.333 0 0012 0c-.354 0-.693.14-.943.39l-6 6a1.333 1.333 0 001.886 1.886L10.667 4.552V16.333a1.333 1.333 0 002.666 0V4.552l3.724 3.724a1.333 1.333 0 001.886-1.886l-6-6zM2.667 13a1.333 1.333 0 00-2.667 0v9.666a1.333 1.333 0 001.333 1.334h21.334A1.333 1.333 0 0024 22.666V13a1.333 1.333 0 00-2.667 0v8.333H2.667V13z" /></svg>,
  bsMore: <svg width="18" height="18" viewBox="0 0 24 24" fill="#6F869F"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>,

  // ── LinkedIn icons (Publer: 20×20, fill #404040) ──
  lnLike: <svg width="20" height="20" viewBox="0 0 24 24" fill="#404040"><path d="M19.135 11.039l-3.74-3.777a9.389 9.389 0 01-1.089-1.38 8.8 8.8 0 01-.545-1.234l-.472-1.416a1.333 1.333 0 00-.218-.472c-.218-.435-.545-.726-.945-.979a2.667 2.667 0 00-1.342-.328c-.473 0-.909.109-1.308.327a2.667 2.667 0 00-.98.98c-.246.391-.372.846-.363 1.308v1.09c0 .943.145 1.778.472 2.722l.4 1.235H4.43c-.363 0-.69.073-1.017.254a1.778 1.778 0 00-.762.763c-.183.326-.255.617-.255 1.018 0 .362.073.69.291 1.016.145.29.327.472.581.653a1.44 1.44 0 00-.617.654 2.133 2.133 0 000 1.017v.037c0 .399.073.69.291 1.016.182.327.4.581.727.763l.218.108-.037.036a1.687 1.687 0 00-.253.909c0 .399.108.726.29 1.016.182.327.399.581.727.763.29.181.581.254.908.254v.145c0 .363.109.69.29 1.017.182.326.4.544.727.762.327.182.653.254 1.018.254h7.188c1.235 0 2.324-.254 3.413-.799l.327-.145h2.397V11.039h-1.49zm-.436 7.661h-.98l-.69.363a5.333 5.333 0 01-2.578.58H7.842a1.067 1.067 0 01-.472-.108 1.6 1.6 0 01-.362-.363c-.036-.073-.073-.145-.073-.218l-.254-.835-.799-.399c-.073 0-.109-.036-.145-.036a.889.889 0 01-.326-.363.711.711 0 01-.146-.472v-.072l.182-.945-.727-.726c-.073-.073-.145-.109-.182-.218a.889.889 0 01-.108-.472c0-.182.036-.327.109-.472l.036-.036.616-1.053-.69-1.053c0-.036-.036-.036-.036-.073a.533.533 0 01-.073-.218c0-.109.036-.182.073-.254l.109-.109.072-.073c.073-.036.145-.036.218-.036h6.79l-1.234-3.777a7.111 7.111 0 01-.363-2.105v-1.09a.533.533 0 01.109-.326.622.622 0 01.254-.29.533.533 0 01.363-.109c.036.036.036.109.073.145l.51 1.416c.18.617.398 1.09.726 1.634.4.653.763 1.198 1.307 1.743l4.32 4.284h.365v5.774l.616.363z" /></svg>,
  lnComment: <svg width="20" height="20" viewBox="0 0 24 24" fill="#404040"><path fillRule="evenodd" clipRule="evenodd" d="M7.32 9.282H17.082v.961H7.32v-.961zm0 3.883h6.84v-.96H7.32v.96zm15.602-1.851c0 1.222-.258 2.257-.887 3.328a6.667 6.667 0 01-1.883 2.07L12.203 21.962V18.044H8.281c-1.258 0-2.328-.258-3.402-.887a6.667 6.667 0 01-2.512-2.515c-.629-1.07-.887-2.145-.887-3.403 0-1.254.258-2.328.887-3.437.63-1.07 1.442-1.848 2.512-2.477a6.667 6.667 0 013.402-.326h7.84a6.667 6.667 0 013.402.926c1.07.63 1.883 1.406 2.512 2.477.63 1.11.887 2.183.887 3.437v.075zm-2.586-2.513a4.622 4.622 0 00-1.773-1.813 4.267 4.267 0 00-2.442-.629H8.281c-.886 0-1.664.184-2.437.63a4.267 4.267 0 00-1.778 1.812 4.8 4.8 0 00-.664 2.437c0 .89.223 1.664.664 2.442a4.267 4.267 0 001.778 1.773c.773.445 1.55.668 2.437.668h5.88v2.219l4.882-3.219c.555-.406.96-.848 1.328-1.441.406-.778.629-1.477.629-2.367v-.075c0-.922-.223-1.66-.664-2.437z" /></svg>,
  lnRepost: <svg width="20" height="20" viewBox="0 0 24 24" fill="#404040"><path d="M13.96 5H6C5.45 5 5 5.45 5 6v10H3V6c0-1.66 1.34-3 3-3h7.96L12 0h2.37L17 4l-2.63 4H12l1.96-3zM19.5 8H19v10c0 .55-.45 1-1 1h-7.96L12 16H9.63L7 20l2.63 4H12l-1.96-3H18c1.66 0 3-1.34 3-3V8h-1.5z" /></svg>,
  lnSend: <svg width="20" height="20" viewBox="0 0 661 661" fill="#404040"><path d="M568 92L13 277l202 113 221-166-166 221 113 202z" /></svg>,
  lnDots: <svg width="16" height="16" viewBox="0 0 16 16"><path fill="rgba(0,0,0,0.75)" d="M3.25 8a1.25 1.25 0 11-2.5 0 1.25 1.25 0 012.5 0zM14 6.75a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5zM8 6.75a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z" /></svg>,
  lnGlobe: <svg width="16" height="16" viewBox="0 0 16 16" fill="rgba(0,0,0,0.6)"><path d="M8 1a7 7 0 107 7 7 7 0 00-7-7zM3 8a5 5 0 011-3l.55.55A1.5 1.5 0 015 6.62v1.07a.75.75 0 00.22.53l.56.56a.75.75 0 00.53.22H7v.69a.75.75 0 00.22.53l.56.56a.75.75 0 01.22.53V13a5 5 0 01-5-5zm6.24 4.83l2-2.46a.75.75 0 00.09-.8l-.58-1.16A.76.76 0 0010 8H7v-.19a.51.51 0 01.28-.45l.38-.19a.74.74 0 01.68 0L9 7.5l.38-.7a1 1 0 00.12-.48v-.85a.78.78 0 01.21-.53l1.07-1.09a5 5 0 01-1.54 9z" /></svg>,

  // ── Google / GMB icons ──
  gDots: <svg width="16" height="16" viewBox="0 0 16 16" fill="#757575"><circle cx="8" cy="2.5" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="8" cy="13.5" r="1.5" /></svg>,
  gShare: <svg width="16" height="16" viewBox="0 0 640 640" fill="#757575"><path d="M427.73 449.33C408.72 438.27 256.61 349.73 237.6 338.67a53.33 53.33 0 002.4-18.67 53.33 53.33 0 00-2.4-18.67C256.4 290.37 406.8 202.69 425.6 191.73A79.68 79.68 0 00480 213.33c44.27 0 80-35.73 80-80s-35.73-80-80-80-80 35.73-80 80c0 6.4 1.07 12.53 2.4 18.67C383.6 162.96 233.2 250.64 214.4 261.6A79.68 79.68 0 00160 240c-44.27 0-80 35.73-80 80s35.73 80 80 80a79.68 79.68 0 0054.4-21.6c19 11.09 170.88 99.84 189.87 110.93A80.07 80.07 0 00402.13 506.67c0 42.93 34.94 77.87 77.87 77.87s77.87-34.94 77.87-77.87-34.94-77.87-77.87-77.87a79.68 79.68 0 00-52.27 20.53z" /></svg>,
};

/* ------------------------------------------------------------------ */
/*  Platform-specific preview renderers                                */
/* ------------------------------------------------------------------ */

/* ---- Shared post-type label helper ---- */
const POST_TYPE_LABELS: Record<string, string> = {
  feed_photo: 'Feed Photo', feed_video: 'Feed Video', reel: 'Reel', story: 'Story', carousel: 'Carousel',
  video: 'Video', short: 'Short', photo_slideshow: 'Photo Slideshow',
  text: 'Text', image: 'Image', pin: 'Pin', video_pin: 'Video Pin', tweet: 'Tweet', post: 'Post',
};

/** Snapchat's own names, kept apart so `story` does not collide with Instagram's. */
const SNAP_POST_TYPE_LABELS: Record<string, string> = {
  story: 'Story', saved_story: 'Saved Story', spotlight: 'Spotlight',
};

/* ---- Carousel viewer with navigation ---- */
function navBtnStyle(side: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    ...(side === 'left' ? { left: '6px' } : { right: '6px' }),
    width: '24px',
    height: '24px',
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.4)',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    zIndex: 2,
  };
}

function CarouselViewer({ urls, aspectRatio, borderRadius, dotColor }: {
  urls: string[];
  aspectRatio: string;
  borderRadius?: string;
  dotColor?: string;
}) {
  const [idx, setIdx] = useState(0);
  if (urls.length === 0) return null;
  const safeIdx = Math.min(idx, urls.length - 1);
  const hasPrev = safeIdx > 0;
  const hasNext = safeIdx < urls.length - 1;

  return (
    <div>
      <div style={{ position: 'relative', width: '100%', aspectRatio, overflow: 'hidden', background: '#F5F5F4', borderRadius: borderRadius || '0' }}>
        <img src={urls[safeIdx]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        {hasPrev && (
          <button type="button" onClick={() => setIdx((i) => i - 1)} style={navBtnStyle('left')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 2 4 7 9 12" /></svg>
          </button>
        )}
        {hasNext && (
          <button type="button" onClick={() => setIdx((i) => i + 1)} style={navBtnStyle('right')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><polyline points="5 2 10 7 5 12" /></svg>
          </button>
        )}
      </div>
      {urls.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '4px', padding: '8px 0' }}>
          {urls.map((_, i) => (
            <span key={i} style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: i === safeIdx ? (dotColor || '#0095F6') : '#D6D3D1',
              transition: 'background 150ms',
            }} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Fallback static carousel dots ---- */
function CarouselDots() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: '4px', padding: '8px 0' }}>
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#0095F6' }} />
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#A8A29E' }} />
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#A8A29E' }} />
    </div>
  );
}

/* ---- Media element: renders <img> or looping <video> ---- */
function MediaEl({ src, isVideo, style }: { src: string; isVideo?: boolean; style?: CSSProperties }) {
  const base: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...style };
  if (isVideo) {
    return <video src={src} autoPlay loop muted playsInline style={base} />;
  }
  return <img src={src} alt="" style={base} />;
}

/* ---- Preview avatar: circular platform icon ---- */
const AVATAR_BG: Record<string, string> = {
  facebook: 'rgba(24, 119, 242, 0.12)',
  instagram: 'rgba(228, 64, 95, 0.12)',
  x: 'rgba(0, 0, 0, 0.08)',
  tiktok: 'rgba(0, 0, 0, 0.08)',
  youtube: 'rgba(255, 0, 0, 0.10)',
  threads: 'rgba(0, 0, 0, 0.08)',
  bluesky: 'rgba(0, 133, 255, 0.12)',
  pinterest: 'rgba(230, 0, 35, 0.10)',
  gmb: 'rgba(66, 133, 244, 0.12)',
  linkedin: 'rgba(10, 102, 194, 0.12)',
  reddit: 'rgba(255, 69, 0, 0.12)',
  discord: 'rgba(88, 101, 242, 0.12)',
  telegram: 'rgba(34, 158, 217, 0.12)',
  tumblr: 'rgba(0, 184, 255, 0.12)',
  snapchat: 'rgba(255, 252, 0, 0.30)',
};

function PreviewAvatar({ platform, size = 40, dark }: { platform: Platform | string; size?: number; dark?: boolean }) {
  // Floor at 20px so the brand logo (notably YouTube) meets the 20dp branding minimum
  // even in the smaller preview headers.
  const iconSize = Math.max(20, Math.round(size * 0.5));
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: dark ? 'rgba(255,255,255,0.2)' : (AVATAR_BG[platform] ?? 'rgba(0,0,0,0.06)'),
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <img
        src={`/assets/platforms/${platform}.svg`} alt=""
        width={iconSize} height={iconSize}
        style={{ display: 'block', ...(dark ? { filter: 'brightness(0) invert(1)' } : {}) }}
      />
    </div>
  );
}

/* ---- Platform-specific multi-image grids ---- */
const imgCover: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };

function PlusOverlay({ count }: { count: number }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '18px', fontWeight: 600 }}>
      +{count}
    </div>
  );
}

/* Facebook & LinkedIn: identical grid patterns, no border radius */
function FacebookLinkedInGrid({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  if (urls.length === 1) {
    return <img src={urls[0]} alt="" style={{ ...imgCover, aspectRatio: '16/9' }} />;
  }
  if (urls.length === 2) {
    return (
      <div style={{ display: 'flex', gap: '2px' }}>
        <img src={urls[0]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
        <img src={urls[1]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
      </div>
    );
  }
  if (urls.length === 3) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <img src={urls[0]} alt="" style={{ ...imgCover, width: '100%', aspectRatio: '2/1' }} />
        <div style={{ display: 'flex', gap: '2px' }}>
          <img src={urls[1]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
          <img src={urls[2]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
        </div>
      </div>
    );
  }
  if (urls.length === 4) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <img src={urls[0]} alt="" style={{ ...imgCover, width: '100%', aspectRatio: '2/1' }} />
        <div style={{ display: 'flex', gap: '2px' }}>
          <img src={urls[1]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
          <img src={urls[2]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
          <img src={urls[3]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
        </div>
      </div>
    );
  }
  // 5+ images: 2 top row, 3 bottom row, +N overlay on last
  const extra = urls.length - 5;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div style={{ display: 'flex', gap: '2px' }}>
        <img src={urls[0]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
        <img src={urls[1]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
      </div>
      <div style={{ display: 'flex', gap: '2px' }}>
        <img src={urls[2]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
        <img src={urls[3]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
        <div style={{ flex: 1, position: 'relative' }}>
          <img src={urls[4]} alt="" style={{ ...imgCover, aspectRatio: '1' }} />
          {extra > 0 && <PlusOverlay count={extra} />}
        </div>
      </div>
    </div>
  );
}

/* X/Twitter: 12px outer corner radius, 0 inner edges, max 4 images */
function XGrid({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  if (urls.length === 1) {
    return (
      <div style={{ borderRadius: '12px', overflow: 'hidden' }}>
        <img src={urls[0]} alt="" style={{ ...imgCover, aspectRatio: '16/9' }} />
      </div>
    );
  }
  if (urls.length === 2) {
    return (
      <div style={{ display: 'flex', gap: '2px', borderRadius: '12px', overflow: 'hidden' }}>
        <img src={urls[0]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '7/8' }} />
        <img src={urls[1]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '7/8' }} />
      </div>
    );
  }
  if (urls.length === 3) {
    return (
      <div style={{ display: 'flex', gap: '2px', borderRadius: '12px', overflow: 'hidden' }}>
        <img src={urls[0]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '7/8' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
          <img src={urls[1]} alt="" style={{ ...imgCover, flex: 1 }} />
          <img src={urls[2]} alt="" style={{ ...imgCover, flex: 1 }} />
        </div>
      </div>
    );
  }
  // 4 images: 2×2 grid
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '2px', borderRadius: '12px', overflow: 'hidden' }}>
      <img src={urls[0]} alt="" style={{ ...imgCover, aspectRatio: '2/1' }} />
      <img src={urls[1]} alt="" style={{ ...imgCover, aspectRatio: '2/1' }} />
      <img src={urls[2]} alt="" style={{ ...imgCover, aspectRatio: '2/1' }} />
      <img src={urls[3]} alt="" style={{ ...imgCover, aspectRatio: '2/1' }} />
    </div>
  );
}

/* Bluesky: 8px outer corner radius, 4px gap, max 4 images */
function BlueskyGrid({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  if (urls.length === 1) {
    return (
      <div style={{ borderRadius: '8px', overflow: 'hidden' }}>
        <img src={urls[0]} alt="" style={{ ...imgCover, aspectRatio: '16/9' }} />
      </div>
    );
  }
  if (urls.length === 2) {
    return (
      <div style={{ display: 'flex', gap: '4px', borderRadius: '8px', overflow: 'hidden' }}>
        <img src={urls[0]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
        <img src={urls[1]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
      </div>
    );
  }
  if (urls.length === 3) {
    return (
      <div style={{ display: 'flex', gap: '4px', borderRadius: '8px', overflow: 'hidden' }}>
        <img src={urls[0]} alt="" style={{ ...imgCover, flex: 1, aspectRatio: '1' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
          <img src={urls[1]} alt="" style={{ ...imgCover, flex: 1 }} />
          <img src={urls[2]} alt="" style={{ ...imgCover, flex: 1 }} />
        </div>
      </div>
    );
  }
  // 4 images: 2×2 grid
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '4px', borderRadius: '8px', overflow: 'hidden' }}>
      <img src={urls[0]} alt="" style={{ ...imgCover, aspectRatio: '1.5' }} />
      <img src={urls[1]} alt="" style={{ ...imgCover, aspectRatio: '1.5' }} />
      <img src={urls[2]} alt="" style={{ ...imgCover, aspectRatio: '1.5' }} />
      <img src={urls[3]} alt="" style={{ ...imgCover, aspectRatio: '1.5' }} />
    </div>
  );
}

function FacebookPreview({ content, mediaUrl, mediaUrls, postType, isVideo, linkPreview, metrics , commentsSlot }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const pt = postType || 'post';
  const isStory = pt === 'story';
  const isReel = pt === 'reel';

  // Story / Reel — vertical 9:16 with white overlay text
  if (isStory || isReel) {
    return (
      <div style={s.card}>
        <div style={s.cardLabel}>
          <span style={{ ...s.dot, background: PLATFORM_COLORS.facebook }} />
          Facebook · {POST_TYPE_LABELS[pt] || pt}
        </div>
        <div style={s.ttWrap}>
          <div style={{ ...s.ttScreen, background: isStory ? 'linear-gradient(160deg, #1877F2, #42A5F5)' : '#0F0F0F' }}>
            {mediaUrl && (
              <MediaEl src={mediaUrl} isVideo={isVideo} style={{ position: 'absolute', inset: 0 }} />
            )}
            <div style={{ position: 'absolute', top: '12px', left: '12px', right: '12px', display: 'flex', alignItems: 'center', gap: '8px', zIndex: 2 }}>
              <PreviewAvatar platform="facebook" size={28} dark />
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#fff' }}>Facebook</span>
              <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)' }}>Just now</span>
            </div>
            <div style={s.ttBottom}>
              {content && <div style={{ fontSize: '13px', color: '#fff', lineHeight: 1.35, wordBreak: 'break-word' as const }}>{truncate(content, 100)}</div>}
            </div>
            {isReel && (
              <div style={s.ttIcons}>
                <div style={s.ttIconItem}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  <span style={s.ttCount}>12</span>
                </div>
                <div style={s.ttIconItem}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  <span style={s.ttCount}>3</span>
                </div>
                <div style={s.ttIconItem}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                  <span style={s.ttCount}>1</span>
                </div>
              </div>
            )}
            {isStory && (
              <div style={{ position: 'absolute', bottom: '10px', left: '10px', right: '10px', zIndex: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ flex: 1, padding: '8px 14px', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.5)', fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
                    Reply to Facebook...
                  </div>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Publer-accurate feed post: wrapper→header→description→media→footer
  const isBigText = content.length > 0 && content.length <= 85 && !mediaUrl && !mediaUrls?.length && !linkPreview;
  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.facebook }} />
        Facebook
      </div>
      {/* Publer-style wrapper */}
      <div style={{ background: '#fff', borderRadius: '10px', border: '1px solid #E5E6EB', padding: '12px 0 0', overflow: 'hidden' }}>
        {/* Header: avatar + name/time + dots */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px', marginBottom: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
            <PreviewAvatar platform="facebook" size={40} />
            <div style={{ marginLeft: '8px' }}>
              <div style={{ fontSize: '15px', fontWeight: 600, color: '#050505' }}>Facebook</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#65676B' }}>Just now</span>
              </div>
            </div>
          </div>
          {icons.fbDots}
        </div>
        {/* Description */}
        {content && (
          <div style={{
            fontSize: isBigText ? '23px' : '15px',
            lineHeight: isBigText ? '28px' : '19px',
            fontWeight: 400,
            color: '#1D2129',
            padding: '0 16px 16px',
            wordBreak: 'break-word' as const,
            whiteSpace: 'pre-wrap' as const,
          }}>
            {content}
          </div>
        )}
        {/* Media */}
        {pt === 'carousel' && mediaUrls && mediaUrls.length > 1 ? (
          <CarouselViewer urls={mediaUrls} aspectRatio="1" dotColor="#1877F2" />
        ) : mediaUrls && mediaUrls.length > 1 ? (
          <FacebookLinkedInGrid urls={mediaUrls} />
        ) : mediaUrl ? (
          <div style={{ width: '100%', background: '#F0F2F5' }}>
            <MediaEl src={mediaUrl} isVideo={isVideo} style={{ width: '100%', display: 'block' }} />
          </div>
        ) : linkPreview ? (
          <FacebookLinkCard linkPreview={linkPreview} />
        ) : null}
        {/* Engagement counts (real — shown in analytics) */}
        {metrics && (metrics.likes + metrics.comments + metrics.shares) > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', fontSize: '13px', color: '#65676B' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ display: 'inline-flex', width: '18px', height: '18px', borderRadius: '50%', background: '#1877F2', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="#fff"><path d="M2 21h4V9H2v12zm20-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L13.17 1 6.59 7.59C6.22 7.95 6 8.45 6 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>
              </span>
              {fmtCount(metrics.likes)}
            </span>
            <span>{fmtCount(metrics.comments)} comments · {fmtCount(metrics.shares)} shares</span>
          </div>
        )}
        {/* Footer: Like / Comment / Share */}
        <div style={{ display: 'flex', justifyContent: 'space-around', borderTop: '1px solid #DADDE1', height: '41px', alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600, color: '#606770', cursor: 'default' }}>{icons.fbLike} Like</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600, color: '#606770', cursor: 'default' }}>{icons.fbComment} Comment</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600, color: '#606770', cursor: 'default' }}>{icons.fbShare} Share</span>
        </div>
        {commentsSlot}
      </div>
    </div>
  );
}

function InstagramPreview({ content, mediaUrl, mediaUrls, postType, isVideo, metrics , commentsSlot }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const pt = postType || 'feed_photo';
  const isVertical = pt === 'reel' || pt === 'story';
  const isCarousel = pt === 'carousel';

  // Reel / Story — vertical 9:16
  if (isVertical) {
    const isStory = pt === 'story';
    return (
      <div style={s.card}>
        <div style={s.cardLabel}>
          <span style={{ ...s.dot, background: PLATFORM_COLORS.instagram }} />
          Instagram · {POST_TYPE_LABELS[pt] || pt}
        </div>
        <div style={s.ttWrap}>
          <div style={{ ...s.ttScreen, background: isStory ? 'linear-gradient(135deg, #833AB4, #E1306C, #F77737)' : s.ttScreen.background }}>
            {mediaUrl && (
              <MediaEl src={mediaUrl} isVideo={isVideo} style={{ position: 'absolute', inset: 0 }} />
            )}
            {/* Story: top bar with avatar + name */}
            {isStory && (
              <div style={{ position: 'absolute', top: '12px', left: '12px', right: '12px', display: 'flex', alignItems: 'center', gap: '8px', zIndex: 2 }}>
                <PreviewAvatar platform="instagram" size={28} dark />
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#fff' }}>Instagram</span>
                <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)' }}>Just now</span>
              </div>
            )}
            {/* Bottom text overlay */}
            <div style={s.ttBottom}>
              {!isStory && <div style={{ ...s.ttUsername, fontSize: '13px' }}>Instagram</div>}
              {content && <div style={s.ttCaption}>{truncate(content, 80)}</div>}
            </div>
            {/* Reel: right-side action icons — white */}
            {!isStory && (
              <div style={s.ttIcons}>
                <div style={s.ttIconItem}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  <span style={s.ttCount}>142</span>
                </div>
                <div style={s.ttIconItem}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  <span style={s.ttCount}>23</span>
                </div>
                <div style={s.ttIconItem}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                </div>
              </div>
            )}
            {/* Story: reply bar at bottom */}
            {isStory && (
              <div style={{ position: 'absolute', bottom: '10px', left: '10px', right: '10px', zIndex: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ flex: 1, padding: '8px 14px', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.5)', fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
                    Send message
                  </div>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.instagram }} />
        Instagram{POST_TYPE_LABELS[pt] ? ` · ${POST_TYPE_LABELS[pt]}` : ''}
      </div>
      {/* Publer-style wrapper */}
      <div style={{ borderRadius: '10px', border: '1px solid #E5E6EB', padding: '0 0 10px', overflow: 'hidden', background: '#fff' }}>
        {/* Header: avatar + name + dots */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px' }}>
          <PreviewAvatar platform="instagram" size={32} />
          <div style={{ flex: 1, marginLeft: '10px' }}>
            <div style={{ fontSize: '16px', fontWeight: 600, color: '#262626' }}>Instagram</div>
          </div>
          {icons.gDots}
        </div>
        {/* Media: 1:1 aspect ratio */}
        {isCarousel && mediaUrls && mediaUrls.length > 1 ? (
          <CarouselViewer urls={mediaUrls} aspectRatio="1" dotColor="#0095F6" />
        ) : (
          <>
            <div style={{ width: '100%', aspectRatio: '1', background: '#F5F5F4', overflow: 'hidden', position: 'relative' as const }}>
              {mediaUrl ? (
                <>
                  <MediaEl src={mediaUrl} isVideo={isVideo} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  {isVideo && pt === 'feed_video' && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                      <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="6 3 20 12 6 21" /></svg>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FAFAF9' }}>
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="#D6D3D1" strokeWidth="1.5"><rect x="4" y="6" width="24" height="20" rx="3" /><circle cx="12" cy="14" r="3" /><path d="M28 22l-6-6-8 8" /></svg>
                </div>
              )}
            </div>
            {isCarousel && <CarouselDots />}
          </>
        )}
        {/* Action icons: like, comment, share (left) + save (right) */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px', marginTop: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '8px' }}>
            {icons.igHeart}
            {icons.igComment}
            {icons.igShare}
          </div>
          <div style={{ padding: '8px' }}>
            {icons.igSave}
          </div>
        </div>
        {/* Likes (real — shown in analytics) */}
        {metrics && metrics.likes > 0 && (
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#262626', padding: '0 16px 2px' }}>{fmtCount(metrics.likes)} likes</div>
        )}
        {/* Description: bold username + caption */}
        {content && (
          <div style={{ fontSize: '16px', color: '#262626', lineHeight: '18px', padding: '0 16px', wordBreak: 'break-word' as const, whiteSpace: 'pre-wrap' as const }}>
            <span style={{ fontWeight: 600 }}>Instagram </span>
            {truncate(content, 100)}
          </div>
        )}
        {/* Comments (real — shown in analytics). The count line is the entry
            point to the thread, so it is suppressed once the thread itself is
            rendered below — otherwise the card says "View all 12 comments"
            directly above those same twelve comments. */}
        {metrics && metrics.comments > 0 && !commentsSlot && (
          <div style={{ fontSize: '14px', color: '#8E8E8E', padding: '4px 16px 0' }}>View all {fmtCount(metrics.comments)} comments</div>
        )}
        {/* Timestamp */}
        <div style={{ fontSize: '10px', color: '#999', fontWeight: 400, textTransform: 'uppercase' as const, padding: '8px 16px 0', letterSpacing: '0.02em' }}>
          Just now
        </div>
        {commentsSlot && <div style={{ marginTop: '10px' }}>{commentsSlot}</div>}
      </div>
    </div>
  );
}

function XPreview({ content, mediaUrl, mediaUrls, isVideo, linkPreview, metrics , commentsSlot }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const allUrls = mediaUrls && mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : [];
  // X collapses a trailing URL into the card and hides the raw link text.
  const showsCard = allUrls.length === 0 && !!linkPreview;
  const displayContent = showsCard ? stripTrailingUrl(content, linkPreview!.url) : content;
  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.x }} />
        X
      </div>
      {/* Publer-style wrapper */}
      <div style={{ background: '#fff', borderRadius: '0', border: '1px solid #E5E6EB', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: '10px', padding: '12px 16px' }}>
          <PreviewAvatar platform="x" size={40} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' as const }}>
              <span style={{ fontSize: '15px', fontWeight: 700, color: '#2F3638' }}>X</span>
              <span style={{ fontSize: '15px', fontWeight: 400, color: '#657786' }}>@x · 1m</span>
              <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{icons.xDots}</span>
            </div>
            {displayContent && <div style={{ fontSize: '15px', color: '#0F1419', lineHeight: 1.45, marginTop: '4px', wordBreak: 'break-word' as const, whiteSpace: 'pre-wrap' as const }}>{truncate(displayContent, 280)}</div>}
            {allUrls.length > 1 ? (
              <div style={{ marginTop: '10px' }}>
                <XGrid urls={allUrls.slice(0, 4)} />
              </div>
            ) : allUrls.length === 1 ? (
              <div style={{ marginTop: '10px', borderRadius: '12px', overflow: 'hidden' }}>
                <MediaEl src={allUrls[0]} isVideo={isVideo} style={{ width: '100%', display: 'block' }} />
              </div>
            ) : linkPreview ? (
              <XLinkCard linkPreview={linkPreview} />
            ) : null}
          </div>
        </div>
        {/* Footer: 5 action icons */}
        <div style={{ display: 'flex', justifyContent: 'space-around', borderTop: '1px solid #EFF3F4', padding: '8px 0', alignItems: 'center' }}>
          <span style={{ ...s.xAction, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{icons.xReply}{metrics && metrics.comments > 0 && <span style={{ fontSize: '13px', color: '#536371' }}>{fmtCount(metrics.comments)}</span>}</span>
          <span style={{ ...s.xAction, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{icons.xRepost}{metrics && metrics.shares > 0 && <span style={{ fontSize: '13px', color: '#536371' }}>{fmtCount(metrics.shares)}</span>}</span>
          <span style={{ ...s.xAction, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{icons.xHeart}{metrics && metrics.likes > 0 && <span style={{ fontSize: '13px', color: '#536371' }}>{fmtCount(metrics.likes)}</span>}</span>
          <span style={s.xAction}>{icons.xBookmark}</span>
          <span style={s.xAction}>{icons.xShare}</span>
        </div>
        {commentsSlot}
      </div>
    </div>
  );
}

function ThreadsPreview({ content, mediaUrl, mediaUrls, postType, isVideo, linkPreview, metrics , commentsSlot }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const pt = postType || 'post';
  const isCarousel = pt === 'carousel';
  const hasMedia = !!mediaUrl || (mediaUrls && mediaUrls.length > 0);

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.threads }} />
        Threads{POST_TYPE_LABELS[pt] ? ` · ${POST_TYPE_LABELS[pt]}` : ''}
      </div>
      {/* Publer-style wrapper */}
      <div style={{ background: '#fff', borderRadius: '0', border: '1px solid #E5E6EB', padding: '0 0 10px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: '10px', padding: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <PreviewAvatar platform="threads" size={36} />
            <div style={{ width: '2px', flex: 1, background: '#E7E5E4', marginTop: '4px', borderRadius: '1px' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '15px', fontWeight: 600, color: '#000' }}>Threads</span>
              <span style={{ fontSize: '13px', color: '#999', marginLeft: 'auto' }}>1m</span>
            </div>
            {content && <div style={{ fontSize: '15px', color: '#000', lineHeight: 1.45, marginTop: '4px', wordBreak: 'break-word' as const, whiteSpace: 'pre-wrap' as const }}>{truncate(content, 500)}</div>}
            {isCarousel && mediaUrls && mediaUrls.length > 1 ? (
              <div style={{ marginTop: '10px' }}>
                <CarouselViewer urls={mediaUrls} aspectRatio="4/5" borderRadius="12px" dotColor="#000" />
              </div>
            ) : hasMedia && mediaUrl ? (
              <div style={{ marginTop: '10px', borderRadius: '12px', overflow: 'hidden' }}>
                <MediaEl src={mediaUrl} isVideo={isVideo} style={{ width: '100%', display: 'block' }} />
              </div>
            ) : linkPreview ? (
              <ThreadsLinkCard linkPreview={linkPreview} />
            ) : isCarousel ? <CarouselDots /> : null}
            {/* 4 action icons: Like, Reply, Repost, Share (color #999) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '10px', color: '#999', fontSize: '14px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{icons.thHeart}{metrics && metrics.likes > 0 ? fmtCount(metrics.likes) : ''}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{icons.thReply}{metrics && metrics.comments > 0 ? fmtCount(metrics.comments) : ''}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{icons.thRepost}{metrics && metrics.shares > 0 ? fmtCount(metrics.shares) : ''}</span>
              {icons.thShare}
            </div>
            {commentsSlot}
          </div>
        </div>
      </div>
    </div>
  );
}

function BlueskyPreview({ content, mediaUrl, mediaUrls, isVideo, linkPreview, metrics , commentsSlot }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const allUrls = mediaUrls && mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : [];
  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.bluesky }} />
        Bluesky
      </div>
      {/* Publer-style wrapper */}
      <div style={{ background: '#fff', borderRadius: '0', border: '1px solid #E5E6EB', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: '10px', padding: '12px 16px' }}>
          <PreviewAvatar platform="bluesky" size={40} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '14px', fontWeight: 700, color: '#000' }}>Bluesky</span>
              <span style={{ fontSize: '14px', fontWeight: 400, color: '#657786' }}>@bluesky.bsky.social · 1m</span>
            </div>
            {content && <div style={{ fontSize: '14px', color: '#000', lineHeight: 1.45, marginTop: '4px', wordBreak: 'break-word' as const, whiteSpace: 'pre-wrap' as const }}>{truncate(content, 300)}</div>}
            {allUrls.length > 1 ? (
              <div style={{ marginTop: '10px' }}>
                <BlueskyGrid urls={allUrls.slice(0, 4)} />
              </div>
            ) : allUrls.length === 1 ? (
              <div style={{ marginTop: '10px', borderRadius: '8px', overflow: 'hidden' }}>
                <MediaEl src={allUrls[0]} isVideo={isVideo} style={{ width: '100%', display: 'block' }} />
              </div>
            ) : linkPreview ? (
              <BlueskyLinkCard linkPreview={linkPreview} />
            ) : null}
          </div>
        </div>
        {/* Footer: 5 action icons */}
        <div style={{ display: 'flex', justifyContent: 'space-around', borderTop: '1px solid #E5E6EB', padding: '8px 0', alignItems: 'center', color: '#6F869F', fontSize: '13px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{icons.bsComment}{metrics && metrics.comments > 0 ? fmtCount(metrics.comments) : ''}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{icons.bsRepost}{metrics && metrics.shares > 0 ? fmtCount(metrics.shares) : ''}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{icons.bsHeart}{metrics && metrics.likes > 0 ? fmtCount(metrics.likes) : ''}</span>
          {icons.bsShare}
          {icons.bsMore}
        </div>
        {commentsSlot}
      </div>
    </div>
  );
}

function YouTubePreview({ content, title, mediaUrl, postType, isVideo, mediaDuration, metrics , commentsSlot }: { content: string; title?: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const pt = postType || 'video';

  // YouTube Short — vertical 9:16
  if (pt === 'short') {
    return (
      <div style={s.card}>
        <div style={s.cardLabel}>
          <span style={{ ...s.dot, background: PLATFORM_COLORS.youtube }} />
          YouTube · Short
        </div>
        <div style={s.ttWrap}>
          <div style={{ ...s.ttScreen, background: '#0F0F0F' }}>
            {mediaUrl && (
              <MediaEl src={mediaUrl} isVideo={isVideo} style={{ position: 'absolute', inset: 0 }} />
            )}
            {!mediaUrl && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </div>
            )}
            <div style={s.ttBottom}>
              <div style={s.ttUsername}>YouTube</div>
              {(title || content) && <div style={s.ttCaption}>{truncate(title || content, 80)}</div>}
            </div>
            <div style={s.ttIcons}>
              <div style={s.ttIconItem}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
                <span style={s.ttCount}>23</span>
              </div>
              <div style={s.ttIconItem}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <span style={s.ttCount}>5</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.youtube }} />
        YouTube · Video
      </div>
      {/* Thumbnail */}
      <div style={s.ytThumbWrap}>
        {mediaUrl ? (
          <MediaEl src={mediaUrl} isVideo={isVideo} style={s.ytThumb} />
        ) : (
          <div style={s.ytThumbPlaceholder}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#D6D3D1" strokeWidth="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        )}
        <span style={s.ytDuration}>{formatDuration(mediaDuration)}</span>
        {/* YouTube progress bar */}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '3px', background: 'rgba(255,255,255,0.3)' }}>
          <div style={{ width: '0%', height: '100%', background: '#FF0000', borderRadius: '0 2px 2px 0' }} />
        </div>
      </div>
      {/* Metadata */}
      <div style={s.ytMeta}>
        <PreviewAvatar platform="youtube" size={28} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {(title || content) && <div style={s.ytTitle}>{truncate(title || content, 60)}</div>}
          <div style={s.ytChannel}>YouTube · {metrics ? fmtCount(metrics.videoViews) : '0'} views{metrics && metrics.likes > 0 ? ` · ${fmtCount(metrics.likes)} likes` : ''} · Just now</div>
        </div>
      </div>
      {commentsSlot}
    </div>
  );
}

function TikTokPreview({ content, mediaUrl, mediaUrls, postType, isVideo, metrics }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null }) {
  const pt = postType || 'video';
  const isSlideshow = pt === 'photo_slideshow';
  const slideshowUrls = isSlideshow && mediaUrls && mediaUrls.length > 1 ? mediaUrls : null;
  const [ssIdx, setSsIdx] = useState(0);
  const safeIdx = slideshowUrls ? Math.min(ssIdx, slideshowUrls.length - 1) : 0;

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.tiktok }} />
        TikTok · {POST_TYPE_LABELS[pt] || pt}
      </div>
      <div style={s.ttWrap}>
        {/* Dark 9:16 preview — Publer phone format */}
        <div style={{ ...s.ttScreen, borderRadius: '16px' }}>
          {slideshowUrls ? (
            <img src={slideshowUrls[safeIdx]} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : mediaUrl ? (
            <MediaEl src={mediaUrl} isVideo={isVideo} style={{ position: 'absolute', inset: 0 }} />
          ) : null}
          {/* Right side nav: avatar, heart + count, comment + count, share + count (NO bookmark) */}
          <div style={s.ttIcons}>
            {/* Account avatar */}
            <div style={{ marginBottom: '6px', border: '2px solid #fff', borderRadius: '50%' }}>
              <PreviewAvatar platform="tiktok" size={40} dark />
            </div>
            <div style={s.ttIconItem}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              <span style={s.ttCount}>{metrics ? fmtCount(metrics.likes) : '142'}</span>
            </div>
            <div style={s.ttIconItem}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M12 2C6.48 2 2 5.8 2 10.4c0 2.8 1.6 5.2 4.1 6.8-.2 1.4-1 2.7-1 2.7s2.3-.5 3.7-1.3c1 .2 2.1.4 3.2.4 5.52 0 10-3.8 10-8.6S17.52 2 12 2z"/><circle cx="8" cy="10.2" r="1.3"/><circle cx="12" cy="10.2" r="1.3"/><circle cx="16" cy="10.2" r="1.3"/></svg>
              <span style={s.ttCount}>{metrics ? fmtCount(metrics.comments) : '23'}</span>
            </div>
            <div style={s.ttIconItem}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M14 3l7 7-7 7v-4.5C8.5 12.5 5 14 2.5 18c.5-5 3.5-9.5 11.5-10.5V3z"/></svg>
              <span style={s.ttCount}>{metrics ? fmtCount(metrics.shares) : '3'}</span>
            </div>
          </div>
          {/* Slideshow dots/nav */}
          {slideshowUrls && (
            <div style={{ position: 'absolute', top: '10px', left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: '4px' }}>
              {slideshowUrls.map((_, i) => (
                <span key={i} style={{
                  width: '6px', height: '6px', borderRadius: '50%',
                  background: i === safeIdx ? '#fff' : 'rgba(255,255,255,0.4)',
                  cursor: 'pointer',
                }} onClick={() => setSsIdx(i)} />
              ))}
            </div>
          )}
          {isSlideshow && !slideshowUrls && (
            <div style={{ position: 'absolute', top: '10px', left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: '4px' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#fff' }} />
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'rgba(255,255,255,0.4)' }} />
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'rgba(255,255,255,0.4)' }} />
            </div>
          )}
          {/* Slideshow navigation arrows */}
          {slideshowUrls && safeIdx > 0 && (
            <button type="button" onClick={() => setSsIdx((i) => i - 1)} style={{ ...navBtnStyle('left'), top: '50%' }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 2 4 7 9 12" /></svg>
            </button>
          )}
          {slideshowUrls && safeIdx < slideshowUrls.length - 1 && (
            <button type="button" onClick={() => setSsIdx((i) => i + 1)} style={{ ...navBtnStyle('right'), top: '50%' }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><polyline points="5 2 10 7 5 12" /></svg>
            </button>
          )}
          {/* Bottom text overlay: name, caption, music row */}
          <div style={s.ttBottom}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>@TikTok</div>
            {content && <div style={s.ttCaption}>{truncate(content, 80)}</div>}
            {/* Music row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
              <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.85)' }}>Original sound - TikTok</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PinterestPreview({ content, title, mediaUrl, mediaUrls, postType, isVideo, mediaDuration }: { content: string; title?: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null }) {
  const pt = postType || 'pin';
  const isCarousel = pt === 'carousel' && mediaUrls && mediaUrls.length > 1;
  const isVideoPin = pt === 'video_pin' || isVideo;

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.pinterest }} />
        Pinterest{POST_TYPE_LABELS[pt] ? ` · ${POST_TYPE_LABELS[pt]}` : ''}
      </div>
      {/* Publer-style: simple card — no avatar, no footer icons, just image + title */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div style={{ background: '#F7F7F7', borderRadius: '16px', overflow: 'hidden', width: '100%' }}>
          {isCarousel ? (
            <CarouselViewer urls={mediaUrls!} aspectRatio="2/3" borderRadius="0" dotColor="#E60023" />
          ) : (
            <div style={{ position: 'relative', width: '100%', aspectRatio: '2/3', background: '#F5F5F4', overflow: 'hidden' }}>
              {mediaUrl ? (
                <>
                  <MediaEl src={mediaUrl} isVideo={isVideo} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  {isVideoPin && (
                    <>
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                        <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="6 3 20 12 6 21" /></svg>
                        </div>
                      </div>
                      {mediaDuration && mediaDuration > 0 && (
                        <span style={{ position: 'absolute', bottom: '8px', left: '8px', background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: '10px', fontWeight: 600, padding: '2px 6px', borderRadius: '4px' }}>
                          {formatDuration(mediaDuration)}
                        </span>
                      )}
                    </>
                  )}
                </>
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FAFAF9' }}>
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="#D6D3D1" strokeWidth="1.5"><rect x="4" y="4" width="24" height="24" rx="3" /><circle cx="12" cy="14" r="3" /><path d="M28 24l-6-6-8 8" /></svg>
                </div>
              )}
            </div>
          )}
          {(title || content) && (
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#111', padding: '10px 12px', lineHeight: 1.35, wordBreak: 'break-word' as const, whiteSpace: 'pre-wrap' as const }}>{truncate(title || content, 60)}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- Link card components per platform ---- */

function FacebookLinkCard({ linkPreview }: { linkPreview: LinkPreviewData }) {
  return (
    <div style={{ margin: '0', background: '#F0F2F5', overflow: 'hidden' }}>
      {linkPreview.image && (
        <img src={linkPreview.image} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
      )}
      <div style={{ padding: '10px 14px' }}>
        <div style={{ fontSize: '10px', color: '#65676B', textTransform: 'uppercase' as const, letterSpacing: '0.03em' }}>{linkPreview.domain}</div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#050505', lineHeight: 1.3, marginTop: '2px' }}>{truncate(linkPreview.title, 80)}</div>
        {linkPreview.description && (
          <div style={{ fontSize: '12px', color: '#65676B', lineHeight: 1.3, marginTop: '2px' }}>{truncate(linkPreview.description, 100)}</div>
        )}
      </div>
    </div>
  );
}

function XLinkCard({ linkPreview }: { linkPreview: LinkPreviewData }) {
  return (
    <div style={{ marginTop: '10px', borderRadius: '12px', border: '1px solid #CFD9DE', overflow: 'hidden' }}>
      {linkPreview.image && (
        <img src={linkPreview.image} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
      )}
      <div style={{ padding: '8px 12px', borderTop: linkPreview.image ? '1px solid #CFD9DE' : 'none' }}>
        <div style={{ fontSize: '12px', color: '#536471' }}>{linkPreview.domain}</div>
        <div style={{ fontSize: '13px', color: '#0F1419', lineHeight: 1.3, marginTop: '1px' }}>{truncate(linkPreview.title, 70)}</div>
      </div>
    </div>
  );
}

function ThreadsLinkCard({ linkPreview }: { linkPreview: LinkPreviewData }) {
  return (
    <div style={{ marginTop: '10px', borderRadius: '12px', border: '1px solid #E7E5E4', overflow: 'hidden' }}>
      {linkPreview.image && (
        <img src={linkPreview.image} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
      )}
      <div style={{ padding: '8px 12px', borderTop: linkPreview.image ? '1px solid #E7E5E4' : 'none' }}>
        <div style={{ fontSize: '11px', color: '#999' }}>{linkPreview.siteName || linkPreview.domain}</div>
        <div style={{ fontSize: '13px', color: '#000', lineHeight: 1.3, marginTop: '1px' }}>{truncate(linkPreview.title, 70)}</div>
      </div>
    </div>
  );
}

function BlueskyLinkCard({ linkPreview }: { linkPreview: LinkPreviewData }) {
  return (
    <div style={{ marginTop: '10px', borderRadius: '8px', border: '1px solid #D3D8DE', overflow: 'hidden' }}>
      {linkPreview.image && (
        <img src={linkPreview.image} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
      )}
      <div style={{ padding: '8px 12px', borderTop: linkPreview.image ? '1px solid #D3D8DE' : 'none' }}>
        <div style={{ fontSize: '12px', color: PLATFORM_COLORS.bluesky }}>{linkPreview.domain}</div>
        <div style={{ fontSize: '13px', color: '#0F1419', lineHeight: 1.3, marginTop: '1px' }}>{truncate(linkPreview.title, 70)}</div>
      </div>
    </div>
  );
}

/**
 * Neutral link card used by platforms that auto-unfurl a URL in the text but
 * don't have a bespoke card mockup (Mastodon, Discord, Telegram). They keep the
 * URL in the copy AND show this card below it — matching real behavior.
 */
function GenericLinkCard({ linkPreview }: { linkPreview: LinkPreviewData }) {
  return (
    <div style={{ borderRadius: '8px', border: '1px solid var(--stone-200)', overflow: 'hidden' }}>
      {linkPreview.image && (
        <img src={linkPreview.image} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
      )}
      <div style={{ padding: '8px 12px' }}>
        <div style={{ fontSize: '11px', color: 'var(--stone-500)' }}>{linkPreview.siteName || linkPreview.domain}</div>
        <div style={{ fontSize: '13px', color: 'var(--stone-900)', lineHeight: 1.3, marginTop: '1px' }}>{truncate(linkPreview.title, 70)}</div>
        {linkPreview.description && (
          <div style={{ fontSize: '12px', color: 'var(--stone-500)', lineHeight: 1.3, marginTop: '2px' }}>{truncate(linkPreview.description, 90)}</div>
        )}
      </div>
    </div>
  );
}

/* ---- Google Business Profile preview ---- */
/** Button labels for GMB callToAction.actionType values. */
const GMB_CTA_LABELS: Record<string, string> = {
  BOOK: 'Book',
  ORDER: 'Order online',
  SHOP: 'Shop',
  LEARN_MORE: 'Learn more',
  SIGN_UP: 'Sign up',
  CALL: 'Call',
};

function GMBPreview({ content, mediaUrl, isVideo, gmbCta }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; gmbCta?: { ctaType?: string; ctaUrl?: string } | null }) {
  const ctaLabel = gmbCta?.ctaType ? GMB_CTA_LABELS[gmbCta.ctaType] : undefined;
  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.gmb }} />
        Google Business
      </div>
      {/* Publer-style wrapper */}
      <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #E5E6EB', padding: '16px 0 0', overflow: 'hidden' }}>
        {/* Header: avatar + verified badge + name/time + share + dots */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, gap: '10px' }}>
            <div style={{ position: 'relative' as const, flexShrink: 0 }}>
              <PreviewAvatar platform="gmb" size={40} />
              {/* Verified badge */}
              <div style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '16px', height: '16px', borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M9 0L11.1 3.5L15.2 2.8L13.8 6.7L17.1 9L13.8 11.3L15.2 15.2L11.1 14.5L9 18L6.9 14.5L2.8 15.2L4.2 11.3L0.9 9L4.2 6.7L2.8 2.8L6.9 3.5L9 0Z" fill="#4285F4" /><path d="M7.8 12.2L4.7 9.1L6.1 7.7L7.8 9.4L11.9 5.3L13.3 6.7L7.8 12.2Z" fill="white" /></svg>
              </div>
            </div>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 400, color: '#222' }}>Google Business</div>
              <div style={{ fontSize: '12px', fontWeight: 400, color: '#70757a' }}>Just now</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {icons.gShare}
            {icons.gDots}
          </div>
        </div>
        {/* Content */}
        {content && <div style={{ fontSize: '14px', color: '#222', lineHeight: '20px', padding: '0 16px 12px', wordBreak: 'break-word' as const, whiteSpace: 'pre-wrap' as const }}>{content}</div>}
        {/* Media — GMB "What's new" posts are an image + optional CTA button;
            a bare URL in the text does NOT unfurl into a link card, so we don't
            show one (matches the publish handler, which ignores linkPreview). */}
        {mediaUrl ? (
          <div style={{ width: '100%', background: '#F1F3F4' }}>
            <MediaEl src={mediaUrl} isVideo={isVideo} style={{ width: '100%', display: 'block' }} />
          </div>
        ) : null}
        {/* CTA button — GMB's only structured link surface (callToAction). */}
        {ctaLabel && (
          <div style={{ padding: '10px 16px 14px' }}>
            <span style={{ display: 'inline-block', fontSize: '14px', fontWeight: 500, color: '#1a73e8', cursor: 'default' }}>{ctaLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function LinkedInPreview({ content, mediaUrl, mediaUrls, isVideo, linkPreview, metrics , commentsSlot }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; title?: string; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const lnActionStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontWeight: 600, color: 'rgba(0,0,0,0.6)', cursor: 'default' };
  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.linkedin }} />
        LinkedIn
      </div>
      {/* Publer-style wrapper */}
      <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #E5E6EB', overflow: 'hidden' }}>
        {/* Header: avatar + name/headline/time + dots */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, gap: '8px' }}>
            <PreviewAvatar platform="linkedin" size={40} />
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'rgba(0,0,0,0.9)' }}>LinkedIn</div>
              <div style={{ fontSize: '12px', fontWeight: 400, color: 'rgba(0,0,0,0.6)', lineHeight: 1.3 }}>Professional Network</div>
              <div style={{ fontSize: '12px', fontWeight: 400, color: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                Just now · {icons.lnGlobe}
              </div>
            </div>
          </div>
          {icons.lnDots}
        </div>
        {/* Content */}
        {content && <div style={{ fontSize: '14px', color: 'rgba(0,0,0,0.9)', lineHeight: '20px', padding: '0 16px 12px', wordBreak: 'break-word' as const, whiteSpace: 'pre-wrap' as const }}>{content}</div>}
        {/* Media */}
        {mediaUrls && mediaUrls.length > 1 ? (
          <FacebookLinkedInGrid urls={mediaUrls} />
        ) : mediaUrl ? (
          <div style={{ width: '100%', background: '#F3F2EF' }}>
            <MediaEl src={mediaUrl} isVideo={isVideo} style={{ width: '100%', display: 'block' }} />
          </div>
        ) : linkPreview && linkPreview.title ? (
          /* LinkedIn's API only renders a card when we supply content.article,
             and the publish handler skips the card when the unfurl produced no
             title — mirror that here. */
          <div style={{ margin: '0', background: '#F3F2EF', overflow: 'hidden' }}>
            {linkPreview.image && (
              <img src={linkPreview.image} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
            )}
            <div style={{ padding: '10px 16px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'rgba(0,0,0,0.9)', lineHeight: 1.3 }}>{truncate(linkPreview.title, 80)}</div>
              <div style={{ fontSize: '12px', color: 'rgba(0,0,0,0.6)', marginTop: '2px' }}>{linkPreview.domain}</div>
            </div>
          </div>
        ) : null}
        {/* Engagement counts (real — shown in analytics) */}
        {metrics && (metrics.likes + metrics.comments + metrics.shares) > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', fontSize: '13px', color: 'rgba(0,0,0,0.6)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ display: 'inline-flex', width: '16px', height: '16px', borderRadius: '50%', background: '#378FE9', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="#fff"><path d="M2 21h4V9H2v12zm20-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L13.17 1 6.59 7.59C6.22 7.95 6 8.45 6 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>
              </span>
              {fmtCount(metrics.likes)}
            </span>
            <span>{fmtCount(metrics.comments)} comments · {fmtCount(metrics.shares)} reposts</span>
          </div>
        )}
        {/* Divider */}
        <div style={{ height: '1px', background: '#E0E0E0', margin: '0 16px' }} />
        {/* Action bar: Like, Comment, Repost, Send */}
        <div style={{ display: 'flex', justifyContent: 'space-evenly', padding: '8px 0' }}>
          <span style={lnActionStyle}>{icons.lnLike} Like</span>
          <span style={lnActionStyle}>{icons.lnComment} Comment</span>
          <span style={lnActionStyle}>{icons.lnRepost} Repost</span>
          <span style={lnActionStyle}>{icons.lnSend} Send</span>
        </div>
        {commentsSlot}
      </div>
    </div>
  );
}

function MastodonPreview({ content, mediaUrl, mediaUrls, isVideo, linkPreview, metrics , commentsSlot }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const allUrls = mediaUrls && mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : [];

  const mastodonAction: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '6px',
    fontSize: '13px', color: '#606984', cursor: 'pointer',
  };

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.mastodon }} />
        Mastodon
      </div>
      <div style={{ background: '#fff', borderRadius: '0', border: '1px solid #C0C7D8', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: '10px', padding: '14px 16px 0' }}>
          <PreviewAvatar platform="mastodon" size={46} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '15px', fontWeight: 700, color: '#1F232B' }}>Mastodon</span>
            </div>
            <div style={{ fontSize: '13px', color: '#606984', marginTop: '-1px' }}>@mastodon@instance</div>
          </div>
          <span style={{ fontSize: '13px', color: '#606984' }}>1m</span>
        </div>

        <div style={{ padding: '8px 16px 10px' }}>
          {content && <div style={{ fontSize: '15px', color: '#1F232B', lineHeight: 1.5, wordBreak: 'break-word' as const, whiteSpace: 'pre-wrap' as const }}>{truncate(content, 500)}</div>}
        </div>

        {allUrls.length > 1 ? (
          <div style={{ padding: '0 16px 12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: allUrls.length === 2 ? '1fr 1fr' : allUrls.length === 3 ? '1fr 1fr' : '1fr 1fr', gap: '2px', borderRadius: '8px', overflow: 'hidden' }}>
              {allUrls.slice(0, 4).map((url, i) => (
                <div key={i} style={{
                  aspectRatio: allUrls.length <= 2 ? '1' : '16/9',
                  ...(allUrls.length === 3 && i === 0 ? { gridColumn: '1 / -1' } : {}),
                }}>
                  <MediaEl src={url} isVideo={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                </div>
              ))}
            </div>
          </div>
        ) : allUrls.length === 1 ? (
          <div style={{ padding: '0 16px 12px' }}>
            <div style={{ borderRadius: '8px', overflow: 'hidden' }}>
              <MediaEl src={allUrls[0]} isVideo={isVideo} style={{ width: '100%', display: 'block' }} />
            </div>
          </div>
        ) : linkPreview ? (
          <div style={{ padding: '0 16px 12px' }}>
            <GenericLinkCard linkPreview={linkPreview} />
          </div>
        ) : null}

        {/* Action bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 16px 10px', borderTop: '1px solid #E6EAF0' }}>
          <span style={mastodonAction}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
            {metrics && metrics.comments > 0 ? fmtCount(metrics.comments) : ''}
          </span>
          <span style={mastodonAction}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
            {metrics && metrics.shares > 0 ? fmtCount(metrics.shares) : ''}
          </span>
          <span style={mastodonAction}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
            {metrics && metrics.likes > 0 ? fmtCount(metrics.likes) : ''}
          </span>
          <span style={mastodonAction}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
          </span>
          <span style={mastodonAction}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>
          </span>
        </div>
        {commentsSlot}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Reddit                                                             */
/*                                                                     */
/*  Measured off the live new-Reddit feed card (2026-08):              */
/*    card radius 16px / padding 4px 16px, title 18px·600 / 24px,      */
/*    credit bar 12px on a 32px row, link thumbnail 130x100 r8,        */
/*    action row = 32px pill buttons, radius 999px, padding 8px 12px,  */
/*    12px·600 labels on --color-secondary-background (#E5EBEE).       */
/*  NOTE: current Reddit has NO left upvote/downvote column — votes    */
/*  live in the first pill of the horizontal action row.               */
/* ------------------------------------------------------------------ */

const REDDIT_FONT = '-apple-system, "system-ui", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
// Reddit RPL light tokens, read off document.documentElement on reddit.com.
const RD_TEXT = '#181C1F';        // --color-neutral-content-strong
const RD_MUTED = '#5C6C74';       // --color-neutral-content-weak
const RD_PILL = '#E5EBEE';        // --color-secondary-background
const RD_UPVOTE = '#D93A00';      // vote-active orange

function RedditPill({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      height: '32px', padding: '0 10px', borderRadius: '999px',
      background: RD_PILL, color: RD_TEXT,
      fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function RedditPreview({ content, title, mediaUrl, mediaUrls, isVideo, linkPreview, metrics , commentsSlot }: { content: string; title?: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const allUrls = mediaUrls && mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : [];
  // Reddit puts the title above the body; when no explicit title is set the
  // first line of the content becomes the title, exactly like the composer does.
  const [firstLine, ...restLines] = content.split('\n');
  const postTitle = title?.trim() || firstLine || '';
  const body = title?.trim() ? content : restLines.join('\n').trim();

  const upvotes = metrics ? metrics.likes : null;

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: '#FF4500' }} />
        Reddit
      </div>
      <div style={{ background: '#FFFFFF', borderRadius: '16px', border: '1px solid #EDEFF1', padding: '8px 16px 12px', fontFamily: REDDIT_FONT }}>
        {/* Credit bar: subreddit avatar · name · age · overflow */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '32px' }}>
          <PreviewAvatar platform="reddit" size={20} />
          <span style={{ fontSize: '12px', fontWeight: 600, color: RD_TEXT }}>r/subreddit</span>
          <span style={{ fontSize: '12px', color: RD_MUTED }}>· 1m ago</span>
          <span style={{ marginLeft: 'auto', color: RD_MUTED, display: 'flex' }}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></svg>
          </span>
        </div>

        {postTitle && (
          <div style={{ fontSize: '18px', fontWeight: 600, lineHeight: '24px', color: RD_TEXT, marginBottom: '8px', wordBreak: 'break-word' as const }}>
            {truncate(postTitle, 300)}
          </div>
        )}

        {allUrls.length > 0 ? (
          // A self post can carry both media and body text, so render both —
          // an image-only post simply has no body to show.
          <>
            <div style={{ borderRadius: '12px', overflow: 'hidden', border: '1px solid #EDEFF1', marginBottom: '8px' }}>
              <MediaEl src={allUrls[0]} isVideo={isVideo} style={{ width: '100%', maxHeight: '340px', display: 'block' }} />
            </div>
            {body && (
              <div style={{ fontSize: '14px', lineHeight: 1.5, color: RD_TEXT, marginBottom: '8px', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }}>
                {truncate(body, 500)}
              </div>
            )}
          </>
        ) : linkPreview ? (
          // Link post: blue outbound URL with a 130x100 thumbnail floated right.
          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '8px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '14px', color: '#0079D3', wordBreak: 'break-all' as const }}>{linkPreview.url}</div>
            </div>
            {linkPreview.image && (
              <img src={linkPreview.image} alt="" style={{ width: '130px', height: '100px', objectFit: 'cover', borderRadius: '8px', flexShrink: 0, display: 'block' }} />
            )}
          </div>
        ) : body ? (
          <div style={{ fontSize: '14px', lineHeight: 1.5, color: RD_TEXT, marginBottom: '8px', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }}>
            {truncate(body, 500)}
          </div>
        ) : null}

        {/* Action row — horizontal pills, matching current Reddit */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' as const }}>
          <RedditPill>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke={RD_UPVOTE} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M10 16V4M10 4l-5 5M10 4l5 5" /></svg>
            {upvotes !== null ? fmtCount(upvotes) : 'Vote'}
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M10 4v12M10 16l-5-5M10 16l5-5" /></svg>
          </RedditPill>
          <RedditPill>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M17 9.5a6.5 6.5 0 0 1-9.4 5.8L3 16.5l1.3-4.4A6.5 6.5 0 1 1 17 9.5z" /></svg>
            {metrics ? fmtCount(metrics.comments) : '0'}
          </RedditPill>
          <RedditPill>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3l3 3-3 3" /><path d="M3 10V8a2 2 0 0 1 2-2h12" /><path d="M6 17l-3-3 3-3" /><path d="M17 10v2a2 2 0 0 1-2 2H3" /></svg>
            {metrics && metrics.shares > 0 ? fmtCount(metrics.shares) : 'Repost'}
          </RedditPill>
          <RedditPill>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 11v4a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-4" /><path d="M10 3v9M10 3L6.5 6.5M10 3l3.5 3.5" /></svg>
            Share
          </RedditPill>
        </div>
        {commentsSlot}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Discord                                                            */
/*                                                                     */
/*  Dark app surface (#313338), 40px circular avatar on the left with  */
/*  a 16px gutter, username row + timestamp, then the message body.    */
/*  Posts made through an integration render with the blurple "APP"    */
/*  badge, which is what an openPublish webhook message actually looks  */
/*  like in a channel. Embeds are a #2B2D31 card with a 4px left       */
/*  accent bar. Blurple #5865F2 verified on discord.com/branding.      */
/* ------------------------------------------------------------------ */

const DISCORD_FONT = '"gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
const DC_SURFACE = '#313338';
const DC_EMBED = '#2B2D31';
const DC_TEXT = '#DBDEE1';
const DC_NAME = '#F2F3F5';
const DC_MUTED = '#949BA4';
const DC_BLURPLE = '#5865F2';
const DC_LINK = '#00A8FC';

function DiscordPreview({ content, mediaUrl, mediaUrls, isVideo, linkPreview, metrics , commentsSlot }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const allUrls = mediaUrls && mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : [];

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: DC_BLURPLE }} />
        Discord
      </div>
      <div style={{ background: DC_SURFACE, borderRadius: '8px', overflow: 'hidden', fontFamily: DISCORD_FONT }}>
        {/* Channel header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', borderBottom: '1px solid rgba(0,0,0,0.24)' }}>
          {/* Discord's channel hash, drawn as four strokes rather than a filled
              outline. The filled path this replaces spanned y 2–16.4 of a
              24-tall viewBox: two thirds of the glyph's height with all the
              slack underneath it, so it sat high against the channel name and
              read as clipped along the bottom. Strokes are symmetric by
              construction — the art is centred and stays centred. */}
          <svg
            width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke={DC_MUTED} strokeWidth="2" strokeLinecap="round"
          >
            <path d="M10.5 3 8 21M16.5 3 14 21M4.5 8.5h16M3.5 15.5h16" />
          </svg>
          <span style={{ fontSize: '15px', fontWeight: 600, color: DC_NAME }}>announcements</span>
        </div>

        <div style={{ display: 'flex', gap: '16px', padding: '10px 16px 16px' }}>
          <PreviewAvatar platform="discord" size={40} dark />
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Username row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' as const, marginBottom: '2px' }}>
              <span style={{ fontSize: '16px', fontWeight: 500, color: DC_NAME }}>openPublish</span>
              <span style={{
                background: DC_BLURPLE, color: '#FFFFFF', fontSize: '10px', fontWeight: 500,
                lineHeight: '15px', padding: '0 4px', borderRadius: '3px', textTransform: 'uppercase' as const,
                letterSpacing: '0.02em',
              }}>App</span>
              <span style={{ fontSize: '12px', color: DC_MUTED }}>Today at 12:00 PM</span>
            </div>

            {content && (
              <div style={{ fontSize: '16px', lineHeight: 1.375, color: DC_TEXT, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }}>
                {truncate(content, 2000)}
              </div>
            )}

            {allUrls.length > 0 && (
              <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap' as const, gap: '4px' }}>
                {allUrls.slice(0, 4).map((url, i) => (
                  <div key={i} style={{ borderRadius: '8px', overflow: 'hidden', maxWidth: allUrls.length > 1 ? 'calc(50% - 2px)' : '400px', flex: allUrls.length > 1 ? '1 1 40%' : '0 1 auto' }}>
                    <MediaEl src={url} isVideo={isVideo && i === 0} style={{ width: '100%', display: 'block', maxHeight: '300px' }} />
                  </div>
                ))}
              </div>
            )}

            {!allUrls.length && linkPreview && (
              <div style={{
                marginTop: '8px', display: 'flex', background: DC_EMBED,
                borderRadius: '4px', borderLeft: `4px solid ${DC_BLURPLE}`, overflow: 'hidden', maxWidth: '432px',
              }}>
                <div style={{ padding: '8px 16px 16px', flex: 1, minWidth: 0 }}>
                  {linkPreview.siteName && <div style={{ fontSize: '12px', color: DC_TEXT, marginTop: '8px' }}>{linkPreview.siteName}</div>}
                  {linkPreview.title && <div style={{ fontSize: '16px', fontWeight: 600, color: DC_LINK, marginTop: '8px', wordBreak: 'break-word' as const }}>{truncate(linkPreview.title, 100)}</div>}
                  {linkPreview.description && <div style={{ fontSize: '14px', lineHeight: 1.3, color: DC_TEXT, marginTop: '8px', wordBreak: 'break-word' as const }}>{truncate(linkPreview.description, 200)}</div>}
                  {linkPreview.image && (
                    <img src={linkPreview.image} alt="" style={{ width: '100%', borderRadius: '4px', marginTop: '16px', display: 'block' }} />
                  )}
                </div>
              </div>
            )}

            {metrics && metrics.likes > 0 && (
              <div style={{ marginTop: '8px', display: 'flex', gap: '4px' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '6px',
                  background: 'rgba(88,101,242,0.16)', border: `1px solid ${DC_BLURPLE}`,
                  borderRadius: '8px', padding: '2px 6px', fontSize: '14px', fontWeight: 600, color: DC_LINK,
                }}>
                  <span role="img" aria-label="reaction">👍</span>{fmtCount(metrics.likes)}
                </span>
              </div>
            )}
            {commentsSlot}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Telegram                                                           */
/*                                                                     */
/*  Geometry taken from the official web client source                 */
/*  (morethanwords/tweb, src/scss/partials/_chatVariables.scss):       */
/*    $bubble-border-radius-big: 15px, -medium: 5px (the tail corner), */
/*    message padding 4px top / 5px bottom / 8px horizontal,           */
/*    --messages-text-size: 16px, secondary 14px, time 12px,           */
/*    --font-regular: Roboto, -apple-system, ...                       */
/*  An openPublish post lands in a channel, so this renders the channel */
/*  view: chat header + left-aligned bubble with a tail, media on top, */
/*  and the view-count/time meta inside the bubble's bottom-right.     */
/* ------------------------------------------------------------------ */

const TELEGRAM_FONT = 'Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif';
const TG_CHAT_BG = '#DCE9F5';
const TG_BUBBLE = '#FFFFFF';
const TG_TEXT = '#000000';
const TG_META = '#707579';
const TG_LINK = '#3390EC';

function TelegramPreview({ content, mediaUrl, mediaUrls, isVideo, linkPreview, metrics }: { content: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null }) {
  const allUrls = mediaUrls && mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : [];
  const hasMedia = allUrls.length > 0;

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: '#229ED9' }} />
        Telegram
      </div>
      <div style={{ borderRadius: '12px', overflow: 'hidden', fontFamily: TELEGRAM_FONT }}>
        {/* Chat top bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', background: '#FFFFFF', borderBottom: '1px solid #DFE1E5' }}>
          <PreviewAvatar platform="telegram" size={34} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '15px', fontWeight: 500, color: TG_TEXT }}>Your Channel</div>
            <div style={{ fontSize: '13px', color: TG_META }}>channel</div>
          </div>
        </div>

        {/* Message area */}
        <div style={{ background: TG_CHAT_BG, padding: '12px' }}>
          <div style={{
            maxWidth: '90%',
            background: TG_BUBBLE,
            borderRadius: '15px 15px 15px 5px',
            boxShadow: '0 1px 2px rgba(16,35,47,0.15)',
            overflow: 'hidden',
          }}>
            {hasMedia && (
              // Telegram albums tile without gaps: 3 photos become one wide
              // photo above a pair, never a 2x2 with a hole in it.
              <div style={{ display: 'grid', gridTemplateColumns: allUrls.length > 1 ? '1fr 1fr' : '1fr', gap: '2px' }}>
                {allUrls.slice(0, 4).map((url, i) => (
                  <div key={i} style={{
                    ...(allUrls.length === 3 && i === 0 ? { gridColumn: '1 / -1' } : {}),
                    aspectRatio: allUrls.length === 1 ? '4/3' : (allUrls.length === 3 && i === 0) ? '2/1' : '1',
                    overflow: 'hidden',
                  }}>
                    <MediaEl src={url} isVideo={isVideo && i === 0} style={{ width: '100%', height: '100%', display: 'block' }} />
                  </div>
                ))}
              </div>
            )}

            <div style={{ padding: '6px 9px 7px' }}>
              {content && (
                <div style={{ fontSize: '16px', lineHeight: 1.31, color: TG_TEXT, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }}>
                  {truncate(content, 1024)}
                </div>
              )}

              {/* Telegram attaches the webpage preview UNDER the message text. */}
              {!hasMedia && linkPreview && (
                <div style={{ borderLeft: `2px solid ${TG_LINK}`, paddingLeft: '8px', marginTop: '4px' }}>
                  {linkPreview.siteName && <div style={{ fontSize: '14px', fontWeight: 500, color: TG_LINK }}>{linkPreview.siteName}</div>}
                  {linkPreview.title && <div style={{ fontSize: '14px', fontWeight: 500, color: TG_TEXT, wordBreak: 'break-word' as const }}>{truncate(linkPreview.title, 90)}</div>}
                  {linkPreview.description && <div style={{ fontSize: '14px', lineHeight: 1.3, color: TG_TEXT, wordBreak: 'break-word' as const }}>{truncate(linkPreview.description, 140)}</div>}
                  {linkPreview.image && <img src={linkPreview.image} alt="" style={{ width: '100%', borderRadius: '4px', marginTop: '4px', display: 'block' }} />}
                </div>
              )}

              {/* Meta sits inside the bubble, flush right */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px', marginTop: '2px', fontSize: '12px', color: TG_META }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>
                <span>{metrics ? fmtCount(metrics.impressions) : '1'}</span>
                <span>12:00 PM</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tumblr                                                             */
/*                                                                     */
/*  Measured off the live www.tumblr.com post view (2026-08):          */
/*    article radius 8px + 1px hairline, header 72px tall with         */
/*    14px padding and a 44px circular avatar, blog name 16px·500,     */
/*    date 14px in #4C5E72, title 26px/34px·400, body 16px/24px,       */
/*    tag links 16px #4C5E72 (2px 6px padding), footer 64px tall with  */
/*    24px icons and 14px·500 counts. Font stack starts at "Favorit".  */
/* ------------------------------------------------------------------ */

const TUMBLR_FONT = 'Favorit, "Helvetica Neue", HelveticaNeue, Helvetica, Arial, sans-serif';
const TB_TEXT = '#000000';
const TB_MUTED = '#4C5E72';

/** Tumblr renders trailing #hashtags as a tag row, not as body text. */
function splitTumblrTags(content: string): { body: string; tags: string[] } {
  const tags: string[] = [];
  let body = content.replace(/\s+$/, '');
  // Peel hashtags off the end, one at a time, so mid-post hashtags stay inline.
  for (;;) {
    const m = body.match(/(?:^|\s)(#[^\s#]+)$/);
    if (!m) break;
    tags.unshift(m[1]);
    body = body.slice(0, body.length - m[1].length).replace(/\s+$/, '');
  }
  return { body, tags };
}

function TumblrPreview({ content, title, mediaUrl, mediaUrls, isVideo, linkPreview, metrics , commentsSlot }: { content: string; title?: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null ; commentsSlot?: React.ReactNode }) {
  const allUrls = mediaUrls && mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : [];
  const { body, tags } = splitTumblrTags(content);

  const footerItem: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '14px', fontWeight: 500, color: TB_MUTED,
  };

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: '#00B8FF' }} />
        Tumblr
      </div>
      <div style={{ background: '#FFFFFF', borderRadius: '8px', boxShadow: '0 0 0 1px rgba(0,25,53,0.13)', overflow: 'hidden', fontFamily: TUMBLR_FONT }}>
        {/* Blog header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 12px 14px 14px' }}>
          <PreviewAvatar platform="tumblr" size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '16px', fontWeight: 500, color: TB_TEXT }}>your-blog</div>
            <div style={{ fontSize: '14px', fontWeight: 350, color: TB_MUTED }}>Just now</div>
          </div>
          <span style={{ color: TB_MUTED, display: 'flex' }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><circle cx="4" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="16" cy="10" r="1.6" /></svg>
          </span>
        </div>

        {/* Media is full-bleed on Tumblr — no side padding, no radius */}
        {allUrls.length > 0 && (
          <div>
            {allUrls.slice(0, 3).map((url, i) => (
              <MediaEl key={i} src={url} isVideo={isVideo && i === 0} style={{ width: '100%', display: 'block' }} />
            ))}
          </div>
        )}

        {(title || body || (!allUrls.length && linkPreview)) && (
          <div style={{ padding: '16px' }}>
            {title && (
              <div style={{ fontSize: '26px', fontWeight: 400, lineHeight: '34px', color: TB_TEXT, marginBottom: '8px', wordBreak: 'break-word' as const }}>
                {truncate(title, 200)}
              </div>
            )}
            {body && (
              <div style={{ fontSize: '16px', lineHeight: '24px', color: TB_TEXT, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }}>
                {truncate(body, 1000)}
              </div>
            )}
            {!allUrls.length && linkPreview && (
              <div style={{ marginTop: '12px' }}>
                <GenericLinkCard linkPreview={linkPreview} />
              </div>
            )}
          </div>
        )}

        {tags.length > 0 && (
          <div style={{ padding: '4px 10px 12px' }}>
            {tags.map((tag) => (
              <span key={tag} style={{ display: 'inline-block', fontSize: '16px', color: TB_MUTED, padding: '2px 6px' }}>{tag}</span>
            ))}
          </div>
        )}

        {/* Footer: replies · reblogs · likes, share pushed right */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px', height: '64px', padding: '0 16px', borderTop: '1px solid rgba(0,25,53,0.07)' }}>
          <span style={footerItem}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z" /></svg>
            {metrics ? fmtCount(metrics.comments) : ''}
          </span>
          <span style={footerItem}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M17 2l4 4-4 4" /><path d="M3 12V8a2 2 0 0 1 2-2h16" /><path d="M7 22l-4-4 4-4" /><path d="M21 12v4a2 2 0 0 1-2 2H3" /></svg>
            {metrics ? fmtCount(metrics.shares) : ''}
          </span>
          <span style={footerItem}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.2l7.8-7.8 1-1.1a5.5 5.5 0 0 0 0-7.7z" /></svg>
            {metrics ? fmtCount(metrics.likes) : ''}
          </span>
          <span style={{ ...footerItem, marginLeft: 'auto' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6" /><path d="M12 3v13M12 3L8 7M12 3l4 4" /></svg>
          </span>
        </div>
        {commentsSlot}
      </div>
    </div>
  );
}

// Platforms with no bespoke mockup that STILL unfurl a URL into an embed.
// (Every platform listed here now has its own renderer; kept for any future
// platform that lands in GenericPreview and unfurls links.)
const GENERIC_UNFURL_PLATFORMS = new Set<string>([]);

function GenericPreview({ content, platform, mediaUrl, isVideo, linkPreview }: { content: string; platform: string; mediaUrl: string | null; isVideo?: boolean; linkPreview?: LinkPreviewData | null }) {
  const showsCard = !mediaUrl && !!linkPreview && GENERIC_UNFURL_PLATFORMS.has(platform);
  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS[platform] || '#78716C' }} />
        {platformDisplayName(platform)}
      </div>
      <div style={s.genericBody}>
        <PreviewAvatar platform={platform as Platform} size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={s.xName}>{platformDisplayName(platform)}</div>
          {content && <div style={s.xText}>{truncate(content, 200)}</div>}
          {showsCard && (
            <div style={{ marginTop: '8px' }}>
              <GenericLinkCard linkPreview={linkPreview!} />
            </div>
          )}
        </div>
      </div>
      {mediaUrl && (
        <div style={{ padding: '0 14px 14px' }}>
          <MediaEl src={mediaUrl} isVideo={isVideo} style={{ width: '100%', borderRadius: '8px' }} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Thread preview renderers                                           */
/* ------------------------------------------------------------------ */

function XThreadPreview({ parts }: { parts: ThreadPartData[] }) {
  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.x }} />
        X · Thread
      </div>
      {parts.map((part, i) => (
        <div key={i}>
          <div style={s.xBody}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <PreviewAvatar platform="x" size={32} />
              {i < parts.length - 1 && (
                <div style={{ width: '2px', flex: 1, background: '#CFD9DE', marginTop: '4px', borderRadius: '1px' }} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={s.xHeader}>
                <span style={s.xName}>X</span>
                <span style={s.xHandle}>@x · 1m</span>
              </div>
              {part.content && <div style={s.xText}>{truncate(part.content, 280)}</div>}
              {i === parts.length - 1 && (
                <div style={s.xActions}>
                  <span style={s.xAction}>{icons.xReply}</span>
                  <span style={s.xAction}>{icons.xRepost}</span>
                  <span style={s.xAction}>{icons.xHeart}</span>
                  <span style={s.xAction}>{icons.xBookmark}</span>
                  <span style={s.xAction}>{icons.xShare}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ThreadsThreadPreview({ parts }: { parts: ThreadPartData[] }) {
  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.threads }} />
        Threads · Thread
      </div>
      {parts.map((part, i) => (
        <div key={i}>
          <div style={s.xBody}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <PreviewAvatar platform="threads" size={32} />
              {i < parts.length - 1 && (
                <div style={{ width: '2px', flex: 1, background: '#E7E5E4', marginTop: '4px', borderRadius: '1px' }} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={s.xHeader}>
                <span style={s.xName}>Threads</span>
                <span style={s.xHandle}>1m</span>
              </div>
              {part.content && <div style={s.xText}>{truncate(part.content, 500)}</div>}
              {i === parts.length - 1 && (
                <div style={{ ...s.xActions, marginTop: '10px', color: '#999' }}>
                  {icons.thHeart}
                  {icons.thReply}
                  {icons.thRepost}
                  {icons.thShare}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function BlueskyThreadPreview({ parts }: { parts: ThreadPartData[] }) {
  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: PLATFORM_COLORS.bluesky }} />
        Bluesky · Thread
      </div>
      {parts.map((part, i) => (
        <div key={i}>
          <div style={s.xBody}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <PreviewAvatar platform="bluesky" size={32} />
              {i < parts.length - 1 && (
                <div style={{ width: '2px', flex: 1, background: '#D3D8DE', marginTop: '4px', borderRadius: '1px' }} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={s.xHeader}>
                <span style={s.xName}>Bluesky</span>
                <span style={s.xHandle}>@bluesky.bsky.social · 1m</span>
              </div>
              {part.content && <div style={s.xText}>{truncate(part.content, 300)}</div>}
              {i === parts.length - 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-around', padding: '8px 0', alignItems: 'center' }}>
                  {icons.bsComment}
                  {icons.bsRepost}
                  {icons.bsHeart}
                  {icons.bsShare}
                  {icons.bsMore}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Snapchat                                                           */
/*                                                                     */
/*  Three surfaces, one 9:16 frame:                                    */
/*    story        — a snap on the public story, 24h, NO caption text  */
/*                   (the API never sends one, so the mockup must not  */
/*                   show one either, or people write captions that    */
/*                   silently vanish)                                  */
/*    saved_story  — same frame plus the title chip Snap pins to it    */
/*    spotlight    — vertical video with the 160-char description and  */
/*                   the right-hand engagement rail                    */
/* ------------------------------------------------------------------ */

const SNAP_YELLOW = '#FFFC00';

function SnapchatPreview({ content, title, mediaUrl, postType, isVideo, metrics }: { content: string; title?: string; mediaUrl: string | null; mediaUrls?: string[]; postType?: string; isVideo?: boolean; linkPreview?: LinkPreviewData | null; mediaDuration?: number | null; metrics?: PreviewMetrics | null }) {
  const pt = postType || 'story';
  const isSpotlight = pt === 'spotlight';
  const isSaved = pt === 'saved_story';
  // Saved Story titles come from the explicit title, falling back to the
  // caption's first line — the same fallback the handler applies.
  const savedTitle = (title || content.split('\n')[0] || '').trim();

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>
        <span style={{ ...s.dot, background: SNAP_YELLOW }} />
        Snapchat · {SNAP_POST_TYPE_LABELS[pt] || pt}
      </div>
      <div style={s.ttWrap}>
        <div style={{ ...s.ttScreen, borderRadius: '16px', background: mediaUrl ? '#000' : 'linear-gradient(160deg, #FFFC00, #FFD400)' }}>
          {mediaUrl && <MediaEl src={mediaUrl} isVideo={isVideo} style={{ position: 'absolute', inset: 0 }} />}

          {/* Story ring: one segment for a single snap, which is all a post is */}
          {!isSpotlight && (
            <div style={{ position: 'absolute', top: '8px', left: '12px', right: '12px', height: '2px', background: 'rgba(255,255,255,0.9)', borderRadius: '1px', zIndex: 2 }} />
          )}

          <div style={{ position: 'absolute', top: '18px', left: '12px', right: '12px', display: 'flex', alignItems: 'center', gap: '8px', zIndex: 2 }}>
            <PreviewAvatar platform="snapchat" size={28} dark />
            <span style={{ fontSize: '12px', fontWeight: 700, color: '#fff' }}>Your Public Profile</span>
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.75)' }}>Just now</span>
          </div>

          {isSaved && savedTitle && (
            <div style={{
              position: 'absolute', top: '54px', left: '12px', zIndex: 2,
              maxWidth: '80%', padding: '4px 10px', borderRadius: '12px',
              background: SNAP_YELLOW, color: '#000',
              fontSize: '12px', fontWeight: 700, lineHeight: 1.3,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {truncate(savedTitle, 45)}
            </div>
          )}

          {isSpotlight && (
            <div style={s.ttIcons}>
              <div style={s.ttIconItem}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                <span style={s.ttCount}>{metrics ? fmtCount(metrics.likes) : '86'}</span>
              </div>
              <div style={s.ttIconItem}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <span style={s.ttCount}>{metrics ? fmtCount(metrics.comments) : '12'}</span>
              </div>
              <div style={s.ttIconItem}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M14 3l7 7-7 7v-4.5C8.5 12.5 5 14 2.5 18c.5-5 3.5-9.5 11.5-10.5V3z"/></svg>
                <span style={s.ttCount}>{metrics ? fmtCount(metrics.shares) : '5'}</span>
              </div>
            </div>
          )}

          <div style={s.ttBottom}>
            {isSpotlight ? (
              content ? <div style={s.ttCaption}>{truncate(content, 160)}</div> : null
            ) : (
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.75)', lineHeight: 1.35 }}>
                Snapchat shows no caption on a story — the snap is the whole post.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderThreadPreview(platform: Platform, parts: ThreadPartData[]) {
  switch (platform) {
    case 'x':
      return <XThreadPreview parts={parts} />;
    case 'threads':
      return <ThreadsThreadPreview parts={parts} />;
    case 'bluesky':
      return <BlueskyThreadPreview parts={parts} />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Main PostPreview component                                         */
/* ------------------------------------------------------------------ */

function renderPreview(platform: Platform, content: string, title: string | undefined, mediaUrl: string | null, mediaUrls: string[], mediaType: 'image' | 'video' | null, postType?: string, linkPreview?: LinkPreviewData | null, mediaDuration?: number | null, metrics?: PreviewMetrics | null, gmbCta?: { ctaType?: string; ctaUrl?: string } | null, commentsSlot?: React.ReactNode) {
  const isVideo = mediaType === 'video';
  const hasMedia = !!mediaUrl || (mediaUrls && mediaUrls.length > 0);
  // Only show link card when there's no media attached (matching real platform behavior)
  const lp = hasMedia ? undefined : linkPreview;
  const props = { content, title, mediaUrl, mediaUrls, postType, isVideo, linkPreview: lp, mediaDuration, metrics, gmbCta, commentsSlot };
  switch (platform) {
    case 'facebook':
      return <FacebookPreview {...props} />;
    case 'instagram':
      return <InstagramPreview {...props} />;
    case 'x':
      return <XPreview {...props} />;
    case 'threads':
      return <ThreadsPreview {...props} />;
    case 'bluesky':
      return <BlueskyPreview {...props} />;
    case 'youtube':
      return <YouTubePreview {...props} />;
    case 'tiktok':
      return <TikTokPreview {...props} />;
    case 'pinterest':
      return <PinterestPreview {...props} />;
    case 'gmb':
      return <GMBPreview {...props} />;
    case 'linkedin':
      return <LinkedInPreview {...props} />;
    case 'mastodon':
      return <MastodonPreview {...props} />;
    case 'reddit':
      return <RedditPreview {...props} />;
    case 'discord':
      return <DiscordPreview {...props} />;
    case 'telegram':
      return <TelegramPreview {...props} />;
    case 'tumblr':
      return <TumblrPreview {...props} />;
    case 'snapchat':
      return <SnapchatPreview {...props} />;
    default:
      return <GenericPreview content={content} platform={platform} mediaUrl={mediaUrl} isVideo={isVideo} linkPreview={lp} />;
  }
}

export default function PostPreview({ content, title, platforms, mediaUrl, mediaUrls, mediaType, postTypes, linkPreview, mediaDuration, threadParts, activePlatform, platformContent, hideHeader, metrics, gmbCta, commentsSlot }: PreviewData) {
  const [activeTab, setActiveTab] = useState<Platform>(platforms[0] ?? 'facebook');

  // Sync activeTab when parent controls the active platform
  const internalTab = platforms.includes(activeTab) ? activeTab : platforms[0];
  const resolvedTab = activePlatform && platforms.includes(activePlatform) ? activePlatform : internalTab;

  // Resolve content: use platform-specific override if available, else global
  const resolvedContent = resolvedTab && platformContent?.[resolvedTab]?.trim()
    ? platformContent[resolvedTab]
    : content;

  if (platforms.length === 0) {
    return (
      <div style={s.empty}>
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="#D6D3D1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="28" height="28" rx="6" />
          <path d="M12 18h12M18 12v12" />
        </svg>
        <p style={s.emptyTitle}>Live Preview</p>
        <p style={s.emptyDesc}>Select platforms to see how your post will look.</p>
      </div>
    );
  }

  return (
    <div style={s.wrapper}>
      {/* Header row: title + platform dropdown (hidden when the parent supplies its own switcher) */}
      {!hideHeader && (
        <div style={s.headerRow}>
          <div style={s.sectionTitle}>PREVIEW</div>
          <div style={s.selectWrap}>
            <PlatformIcon platform={resolvedTab} size="xs" />
            <select
              value={resolvedTab}
              onChange={(e) => {
                setActiveTab(e.target.value as Platform);
              }}
              style={s.select}
            >
              {platforms.map((p) => (
                <option key={p} value={p}>{platformDisplayName(p)}</option>
              ))}
            </select>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none', flexShrink: 0 }}>
              <polyline points="3 4.5 6 7.5 9 4.5" />
            </svg>
          </div>
        </div>
      )}

      {/* Active preview */}
      {resolvedTab && threadParts && threadParts.length >= 2
        ? renderThreadPreview(resolvedTab, threadParts)
        : resolvedTab && renderPreview(resolvedTab, resolvedContent, title, mediaUrl, mediaUrls || [], mediaType, postTypes?.[resolvedTab], linkPreview, mediaDuration, metrics, gmbCta, commentsSlot)
      }
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const s: Record<string, CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--stone-500)',
    letterSpacing: '0.05em',
    margin: 0,
  },
  selectWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    background: 'var(--surface-card)',
    borderRadius: 'var(--radius-pill)',
    padding: '8px',
  },
  select: {
    appearance: 'none' as const,
    border: 'none',
    background: 'transparent',
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--stone-700)',
    cursor: 'pointer',
    outline: 'none',
    paddingRight: '2px',
  },
  card: {
    background: '#FFFFFF',
    borderRadius: '12px',
    border: 'none',
  },
  cardLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 14px',
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--stone-500)',
  },
  dot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '6px',
    padding: '32px 16px',
    textAlign: 'center',
  },
  emptyTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--stone-500)',
    margin: 0,
  },
  emptyDesc: {
    fontSize: '12px',
    color: 'var(--stone-400)',
    margin: 0,
    lineHeight: 1.4,
  },

  // ── X / Twitter (shared with thread previews) ──
  xBody: {
    display: 'flex',
    gap: '10px',
    padding: '14px',
  },
  xHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexWrap: 'wrap',
  },
  xName: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#0F1419',
  },
  xHandle: {
    fontSize: '12px',
    color: '#536471',
  },
  xText: {
    fontSize: '13px',
    color: '#0F1419',
    lineHeight: 1.45,
    marginTop: '4px',
    wordBreak: 'break-word',
  },
  xActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    marginTop: '8px',
  },
  xAction: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '12px',
    color: '#536471',
  },

  // ── YouTube ──
  ytThumbWrap: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16/9',
    background: '#0F0F0F',
    overflow: 'hidden',
  },
  ytThumb: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  ytThumbPlaceholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#1A1A1A',
  },
  ytDuration: {
    position: 'absolute',
    bottom: '6px',
    right: '6px',
    background: 'rgba(0,0,0,0.8)',
    color: '#FFF',
    fontSize: '10px',
    fontWeight: 600,
    padding: '2px 4px',
    borderRadius: '3px',
    lineHeight: 1,
  },
  ytMeta: {
    display: 'flex',
    gap: '10px',
    padding: '10px 14px 12px',
    alignItems: 'flex-start',
  },
  ytTitle: {
    fontSize: '13px',
    fontWeight: 500,
    color: '#0F0F0F',
    lineHeight: 1.35,
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  },
  ytChannel: {
    fontSize: '11px',
    color: '#606060',
    marginTop: '3px',
    lineHeight: 1.3,
  },

  // ── TikTok ──
  ttWrap: {
    padding: '0 14px 14px',
  },
  ttScreen: {
    position: 'relative',
    width: '100%',
    aspectRatio: '9/14',
    background: 'linear-gradient(180deg, #1A1A1A 0%, #2D2D2D 100%)',
    borderRadius: '10px',
    overflow: 'hidden',
    display: 'flex',
  },
  ttIcons: {
    position: 'absolute',
    right: '8px',
    bottom: '50px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '14px',
  },
  ttIconItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
  },
  ttCount: {
    fontSize: '10px',
    color: '#FFF',
    fontWeight: 500,
  },
  ttBottom: {
    position: 'absolute',
    bottom: '10px',
    left: '10px',
    right: '40px',
  },
  ttUsername: {
    fontSize: '12px',
    fontWeight: 600,
    color: '#FFF',
    marginBottom: '4px',
  },
  ttCaption: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.85)',
    lineHeight: 1.35,
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  },

  // ── Generic ──
  genericBody: {
    display: 'flex',
    gap: '10px',
    padding: '14px',
  },
};
