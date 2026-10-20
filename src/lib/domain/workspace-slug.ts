/**
 * A new workspace's slug. Slugs are unique across every tenant (workspaces_slug_key), but a signed-in caller's store
 * only sees its own workspaces, so a name another tenant already used cannot be checked first. With shared
 * identities the slug therefore carries a suffix of the new workspace's own random id; demo mode has one workspace.
 */
export function workspaceSlug(name: string, workspaceId: string, shared: boolean): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 30) || "workspace";
  if (!shared) return base;
  const suffix = workspaceId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6);
  return `${base}-${suffix}`;
}
