/**
 * Central role → capability matrix for organization team members.
 *
 * This is the single source of truth for "what can a member with role X do".
 * Route handlers and UI both call `can()` / `canGrantRole()` rather than
 * hand-rolling role checks, so the rules stay consistent.
 *
 * Phase 1 (invitations + roles) only enforces the team-management capabilities
 * (`members:manage` + grant authority). The post-related capabilities
 * (`post:publish`, `post:approve`) are defined here so Phase 2 (approvals) can
 * wire them in alongside the org's `requireApproval` setting — until then,
 * anyone who can create a post can also publish it (so a roles-only org isn't
 * left unable to publish).
 */

export type OrgRole = 'owner' | 'admin' | 'approver' | 'contributor' | 'viewer';

/**
 * Roles as they may appear in the database. `member` is the legacy role from
 * before this model existed. Production ran `drizzle-kit push` for its whole
 * history — DDL-only, no data backfill — so the remap that shipped as a migration
 * never executed against those rows. Deploys now apply migration files properly,
 * but the un-remapped rows are still out there, so any surviving `member` is
 * normalized to `admin` here.
 */
export type StoredOrgRole = OrgRole | 'member';

export type Capability =
  | 'members:manage' // invite teammates, change roles, remove members
  | 'billing:manage' // manage the subscription / billing
  | 'org:delete' // delete the organization
  | 'post:create' // create and edit drafts
  | 'post:publish' // schedule or publish directly (bypassing approval)
  | 'post:approve' // approve / reject other members' posts (Phase 2)
  | 'analytics:read'; // view posts and analytics

const MATRIX: Record<OrgRole, readonly Capability[]> = {
  owner: [
    'members:manage',
    'billing:manage',
    'org:delete',
    'post:create',
    'post:publish',
    'post:approve',
    'analytics:read',
  ],
  // Admin manages the team and publishes, but cannot touch billing or delete the org.
  admin: ['members:manage', 'post:create', 'post:publish', 'post:approve', 'analytics:read'],
  // Approver can publish and approve, but cannot manage the team.
  approver: ['post:create', 'post:publish', 'post:approve', 'analytics:read'],
  // Contributor can only create/edit drafts and submit them for approval.
  contributor: ['post:create', 'analytics:read'],
  // Viewer is read-only.
  viewer: ['analytics:read'],
};

export const ALL_ORG_ROLES: readonly OrgRole[] = [
  'owner',
  'admin',
  'approver',
  'contributor',
  'viewer',
];

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  approver: 'Approver',
  contributor: 'Contributor',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<OrgRole, string> = {
  owner: 'Full access, including billing and deleting the workspace.',
  admin: 'Manage the team and publish posts; no billing or workspace deletion.',
  approver: "Create, publish, and approve teammates' posts.",
  contributor: 'Create posts and submit them for approval.',
  viewer: 'Read-only access to posts and analytics.',
};

/**
 * Coerce a stored role string into a known `OrgRole`. Legacy `member` → `admin`;
 * anything unrecognized falls back to the least-privileged `viewer` (fail safe).
 */
export function normalizeRole(role: string | null | undefined): OrgRole {
  if (role === 'member') return 'admin';
  if (
    role === 'owner' ||
    role === 'admin' ||
    role === 'approver' ||
    role === 'contributor' ||
    role === 'viewer'
  ) {
    return role;
  }
  return 'viewer';
}

/** Does a member with `role` have `capability`? */
export function can(role: string | null | undefined, capability: Capability): boolean {
  return MATRIX[normalizeRole(role)].includes(capability);
}

/**
 * Roles an actor may grant when inviting or changing a member's role.
 * Only the Owner can grant Admin; ownership transfer is a separate flow, so
 * `owner` is never assignable through the team routes.
 */
const GRANTABLE: Record<OrgRole, readonly OrgRole[]> = {
  owner: ['admin', 'approver', 'contributor', 'viewer'],
  admin: ['approver', 'contributor', 'viewer'],
  approver: [],
  contributor: [],
  viewer: [],
};

export function assignableRoles(actorRole: string | null | undefined): OrgRole[] {
  return [...(GRANTABLE[normalizeRole(actorRole)] ?? [])];
}

export function canGrantRole(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  return assignableRoles(actorRole).includes(normalizeRole(targetRole));
}

/** Is this a real, assignable invite/member role? (Excludes legacy `member` and `owner`.) */
export function isAssignableRole(role: string): role is Exclude<OrgRole, 'owner'> {
  return role === 'admin' || role === 'approver' || role === 'contributor' || role === 'viewer';
}
