/**
 * zod 4 renamed several issue codes. API error text keeps the zod 3 names that clients already match on.
 * shortcut: a one-value enum failure reads as invalid_literal (zod 4 does not keep enum vs literal); fine for clients.
 */
export function legacyIssueCode(issue: { code: string; values?: unknown; note?: unknown }): string {
  switch (issue.code) {
    case "invalid_format": return "invalid_string";
    case "invalid_value": return Array.isArray(issue.values) && issue.values.length === 1 ? "invalid_literal" : "invalid_enum_value";
    case "invalid_union": return issue.note === "No matching discriminator" ? "invalid_union_discriminator" : "invalid_union";
    default: return issue.code;
  }
}
