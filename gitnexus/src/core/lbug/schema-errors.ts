/**
 * Check whether a LadybugDB error reports a missing schema table, column, or property.
 * Callers may recover from these legacy-schema cases, but must propagate
 * connection, query, and other runtime failures.
 */
export const isMissingColumnOrTableError = (message: string): boolean =>
  // Allow only direct Binder missing-object grammar with terminal punctuation/whitespace.
  /^Binder exception:[ \t]*(?:table|column|property)[ \t]+[^\s]+[ \t]+(?:does not exist|not found(?:[ \t]+(?:in catalog|for e))?)[.]?[ \t]*$/i.test(
    message,
  );
