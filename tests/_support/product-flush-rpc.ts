/**
 * Fake `zenith_product_flush` (supabase/migrations/0027) for the in-process
 * PostgREST fakes. It replays the one-transaction flush as the per-row calls
 * those fakes already record (`insert:<table>`, `update:<table>`,
 * `delete:<table>`), and refuses the whole call with PZ409 when `refuse` says a
 * guarded row moved, like the function does. `apply` lets a fake keep its own
 * table contents in step; it runs only when nothing is refused, because the
 * real call is all-or-nothing.
 */
export interface FlushWrite { table: string; key: Record<string, unknown>; baseline: number | null; row: Record<string, unknown> }
export interface FlushDelete { table: string; key: Record<string, unknown>; baseline: number }

export function productFlushRpc(
  record: (call: string) => void,
  refuse: (table: string, op: "update" | "delete") => boolean = () => false,
  apply?: (writes: FlushWrite[], deletes: FlushDelete[]) => void,
) {
  return async (fn: string, args?: { p_writes?: FlushWrite[]; p_deletes?: FlushDelete[] }) => {
    if (fn !== "zenith_product_flush") return { data: null, error: { code: "PGRST202", message: `no fake for ${fn}` } };
    const writes = args?.p_writes ?? [], deletes = args?.p_deletes ?? [];
    let refused = false;
    for (const w of writes) {
      const op = w.baseline === null ? "insert" : "update";
      record(`${op}:${w.table}`);
      if (op === "update" && refuse(w.table, op)) refused = true;
    }
    for (const d of deletes) {
      record(`delete:${d.table}`);
      if (refuse(d.table, "delete")) refused = true;
    }
    if (refused) return { data: null, error: { code: "PZ409", message: "zenith_product_flush: row moved since it was loaded" } };
    apply?.(writes, deletes);
    return { data: null, error: null };
  };
}
