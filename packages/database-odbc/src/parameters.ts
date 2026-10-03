/** Translate compiler markers to ODBC positional markers without touching SQL tokens. */
export function positionalParameters<T>(sql: string, values: readonly T[]): { sql: string; parameters: T[] } {
  const parameters: T[] = [];
  const used = new Set<number>();
  let output = "";
  let cursor = 0;
  let positional = 0;
  let markerKind: "named" | "positional" | undefined;
  while (cursor < sql.length) {
    const char = sql[cursor]!;
    const next = sql[cursor + 1];
    // Oracle alternative quoted strings, including paired delimiters.
    if ((char === "q" || char === "Q") && next === "'" && !/[\w$#]/.test(sql[cursor - 1] ?? "")) {
      const delimiter = sql[cursor + 2];
      if (!delimiter) throw new TypeError("Unterminated SQL quote");
      const closer = ({ "[": "]", "{": "}", "(": ")", "<": ">" } as Record<string, string>)[delimiter] ?? delimiter;
      const end = sql.indexOf(`${closer}'`, cursor + 3);
      if (end === -1) throw new TypeError("Unterminated SQL quote");
      output += sql.slice(cursor, end + 2); cursor = end + 2; continue;
    }
    if (char === "'" || char === '"' || char === "[" || char === "`") {
      const closer = char === "[" ? "]" : char;
      const start = cursor++;
      let terminated = false;
      while (cursor < sql.length) {
        if (sql[cursor++] === closer) {
          if (sql[cursor] === closer) { cursor++; continue; }
          terminated = true; break;
        }
      }
      if (!terminated) throw new TypeError("Unterminated SQL quote");
      output += sql.slice(start, cursor); continue;
    }
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", cursor + 2);
      const finish = end === -1 ? sql.length : end;
      output += sql.slice(cursor, finish); cursor = finish; continue;
    }
    if (char === "/" && next === "*") {
      const start = cursor; cursor += 2; let depth = 1;
      while (cursor < sql.length && depth) {
        if (sql[cursor] === "/" && sql[cursor + 1] === "*") { depth++; cursor += 2; }
        else if (sql[cursor] === "*" && sql[cursor + 1] === "/") { depth--; cursor += 2; }
        else cursor++;
      }
      if (depth) throw new TypeError("Unterminated SQL comment");
      output += sql.slice(start, cursor); continue;
    }
    const named = (char === "@" || char === ":") && !/[\w$#@:]/.test(sql[cursor - 1] ?? "")
      ? /^[@:]p([1-9]\d*)(?![\w$#])/i.exec(sql.slice(cursor)) : null;
    if (named || char === "?") {
      const kind = named ? "named" : "positional";
      if (markerKind && markerKind !== kind) throw new TypeError("Cannot mix named and positional ODBC parameters");
      markerKind = kind;
      const index = named ? Number(named[1]) - 1 : positional++;
      if (!Number.isSafeInteger(index) || index >= values.length) throw new TypeError("Missing SQL parameter");
      parameters.push(values[index]!); used.add(index);
      output += "?"; cursor += named?.[0].length ?? 1; continue;
    }
    output += char; cursor++;
  }
  if (used.size !== values.length) throw new TypeError("Unused SQL parameters");
  return { sql: output, parameters };
}
