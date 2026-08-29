/**
 * Minimal ambient typings for `jsdom` (no `@types/jsdom` is installed).
 *
 * Covers only what lib/collect/extract.ts uses: constructing `JSDOM` / `VirtualConsole`
 * and reading `.window`. `window` is typed `any` so DOM access (`document`, `body`,
 * `textContent`) type-checks without pulling the full @types/jsdom surface. If jsdom usage
 * grows, prefer installing `@types/jsdom` over expanding this shim.
 */
declare module 'jsdom' {
  export class VirtualConsole {
    on(event: string, listener: (...args: any[]) => void): this;
    sendTo(console: Console, options?: { omitJSDOMErrors?: boolean }): this;
  }

  export interface ConstructorOptions {
    url?: string;
    referrer?: string;
    contentType?: string;
    runScripts?: 'dangerously' | 'outside-only';
    virtualConsole?: VirtualConsole;
    pretendToBeVisual?: boolean;
    resources?: unknown;
  }

  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: any;
    serialize(): string;
  }
}
