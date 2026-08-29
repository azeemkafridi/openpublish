/**
 * Regression tests for media file_name clamping.
 *
 * media_files.file_name is varchar(255). Nothing bounded the value: browser
 * uploads carry the OS name, and rehostUrlToMedia derives it from the last path
 * segment of a remote URL. On 2026-08-11 an IFTTT applet passed a signed CDN
 * link whose final segment was ~400 chars; the R2 original and all three
 * derivatives uploaded, then the insert died with "value too long for type
 * character varying(255)" — orphaning four objects. IFTTT swallows media
 * errors, so the post was created with no media and then failed to publish
 * with "requires an image (no media attached)", which blamed the user for
 * omitting media they had actually supplied.
 */

const { clampFileName } = await import('@/lib/media/upload');

export {};

const LIMIT = 255;

describe('clampFileName', () => {
  it('leaves an ordinary name untouched', () => {
    expect(clampFileName('photo.jpg', '.jpg')).toBe('photo.jpg');
  });

  it('leaves a name exactly at the limit untouched', () => {
    const name = 'a'.repeat(LIMIT - 4) + '.jpg';
    expect(name).toHaveLength(LIMIT);
    expect(clampFileName(name, '.jpg')).toBe(name);
  });

  it('clamps the 400-char signed-CDN name that caused the outage', () => {
    // Shape of the real value: a long opaque token followed by .jpg
    const name = `${'E0EunWlH6IGj1ZtLi9Bsp'.repeat(20)}.jpg`;
    expect(name.length).toBeGreaterThan(400);

    const result = clampFileName(name, '.jpg');

    expect(result.length).toBeLessThanOrEqual(LIMIT);
    expect(result.endsWith('.jpg')).toBe(true);
  });

  it('preserves the extension rather than truncating into it', () => {
    const result = clampFileName('x'.repeat(300) + '.jpeg', '.jpeg');

    expect(result.length).toBeLessThanOrEqual(LIMIT);
    // The bug we are guarding against is "photo.jpg" -> "photo.j"
    expect(result.endsWith('.jpeg')).toBe(true);
    expect(result.startsWith('x')).toBe(true);
  });

  it('handles a long name with no extension', () => {
    const result = clampFileName('y'.repeat(400), '');

    expect(result).toHaveLength(LIMIT);
    expect(result).toBe('y'.repeat(LIMIT));
  });

  it('falls back to a placeholder for an empty or whitespace name', () => {
    expect(clampFileName('', '.jpg')).toBe('media.jpg');
    expect(clampFileName('   ', '.png')).toBe('media.png');
  });

  it('still returns something within the limit if the extension itself is absurd', () => {
    const ext = '.' + 'z'.repeat(400);
    const result = clampFileName('file' + ext, ext);

    // Degenerate input must not throw or produce a negative slice.
    expect(result.length).toBeGreaterThan(0);
  });
});
