/// <reference path="../.astro/types.d.ts" />

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

declare namespace App {
  interface Locals {
    auth: {
      user: AuthUser | null;
      authType: 'session' | 'api_key' | 'oauth';
      organizationId: number;
      organizationName: string;
      organizationPlan: 'free' | 'pro' | 'business';
      /** Caller's membership role in the active org (team permissions). */
      organizationRole: 'owner' | 'admin' | 'approver' | 'contributor' | 'viewer';
      /** Granted OAuth scopes — present only when authType is 'oauth'. */
      scopes?: string[];
    };
  }
}
