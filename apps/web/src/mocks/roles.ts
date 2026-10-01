/** Mirrors apps/api/modules/project/roles.py (M02 §5 role-change rules). */
const ADMIN_MANAGEABLE = new Set(["RESEARCHER", "VIEWER"]);

export function canManageMember(actorRole: string | null | undefined, ...rolesInvolved: string[]): boolean {
  if (actorRole === "PROJECT_OWNER") return true;
  if (actorRole === "PROJECT_ADMIN") return rolesInvolved.length > 0 && rolesInvolved.every((r) => ADMIN_MANAGEABLE.has(r));
  return false;
}

export function dropsAnOwner(currentRole: string, newRole: string | null): boolean {
  return currentRole === "PROJECT_OWNER" && newRole !== "PROJECT_OWNER";
}
