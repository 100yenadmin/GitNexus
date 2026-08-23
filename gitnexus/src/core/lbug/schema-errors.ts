/**
 * Check whether a LadybugDB error reports a missing schema table, column, or property.
 * Callers may recover from these legacy-schema cases, but must propagate
 * connection, query, and other runtime failures.
 */
export const isMissingColumnOrTableError = (message: string): boolean =>
  // Require a schema object on the same line as the missing-schema wording.
  // Unscoped "does not exist"/"not found" messages include runtime failures
  // such as "connection does not exist" and "key not found".
  /\b(?:table|column|property)\b[^\n]*?\b(?:does not exist|not found)\b/i.test(message);
