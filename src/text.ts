// Shared by PDF metadata/filename rewriting and upload filename rejection so
// both surfaces classify C0/C1 control characters consistently. Rendered PDF
// body text intentionally preserves meaningful newlines and tabs.
export function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 31 ||
    (codePoint >= 127 && codePoint <= 159) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

/** Replace header/metadata control characters with spaces without changing printable text. */
export function flattenControlCharacters(value: string): string {
  return [...value]
    .map((character) => (isControlCodePoint(character.codePointAt(0) ?? 0) ? " " : character))
    .join("");
}
