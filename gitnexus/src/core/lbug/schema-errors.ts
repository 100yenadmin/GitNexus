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

/** Match only LadybugDB's explicit missing-table error for the expected table. */
export const isExpectedMissingTableError = (message: string, expectedTable: string): boolean => {
  const escapedTable = expectedTable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^Binder exception:\\s*Table\\s+${escapedTable}\\s+does not exist\\.?$`).test(
    message.trim(),
  );
};
