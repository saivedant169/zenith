/** Exact hosted project binding, plus the owned CLI default-stack endpoint.
 * This only describes an endpoint. Callers must still prove the opened native
 * handle, REST client, same database authority and locked current rows.
 */
export function mcpProductEndpoint(api: URL, database: URL): boolean {
  if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash
    || api.pathname !== "/" || !["postgres:", "postgresql:"].includes(database.protocol)
    || database.pathname !== "/postgres" || database.hash) return false;
  const options = [...database.searchParams];
  if (options.length > 1 || options.some(([key, value]) => key !== "sslmode" || !["require", "verify-full"].includes(value))) return false;
  const username = decodeURIComponent(database.username), port = database.port || "5432";
  // Hosted project references retain the existing exact 20-character guard, not a
  // generic hostname or a shorter convenient fixture alias.
  const hosted = /^([a-z0-9]{20})\.supabase\.co$/.exec(api.hostname);
  if (hosted && !api.port) {
    return (database.hostname === `db.${hosted[1]}.supabase.co` && ["5432", "6543"].includes(port) && username === "postgres")
      || (/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(database.hostname) && ["5432", "6543"].includes(port) && username === `postgres.${hosted[1]}`);
  }
  // The CLI default 54321, or the owned default-stack harness's whole-thousand shift of it (offset 1000..10000).
  const local = /^(5[4-9]|6[0-4])321$/.test(api.port);
  return api.hostname === "supabase.localhost" && local
    && database.hostname === "supabase-pooler" && port === "6543" && username === "postgres.pooler-dev"
    && options.length === 1 && options[0][1] === "verify-full";
}
