const CELL_LIMIT = 64;

const toCell = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

const truncate = (text: string): string =>
  text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT - 1)}…` : text;

function printTable(rows: Record<string, unknown>[]): void {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const cells = rows.map(row => keys.map(key => truncate(toCell(row[key]))));
  const widths = keys.map((key, i) => Math.min(80, Math.max(key.length, ...cells.map(row => row[i]!.length))));

  console.log(keys.map((key, i) => key.padEnd(widths[i]!)).join('  '));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const row of cells) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '));
  }
}

/**
 * Universal output. `--json` prints the raw API value; otherwise a human rendering:
 * arrays of objects become aligned tables, objects become `key  value` lines,
 * strings print as-is.
 */
export function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value ?? null, null, 2));
    return;
  }
  if (value === undefined || value === null) {
    console.log('ok');
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      console.log('(empty)');
      return;
    }
    const objects = value.filter(item => item !== null && typeof item === 'object');
    if (objects.length === value.length) {
      printTable(objects as Record<string, unknown>[]);
      return;
    }
    for (const item of value) console.log(toCell(item));
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      console.log('(empty)');
      return;
    }
    const width = Math.max(...entries.map(([key]) => key.length));
    for (const [key, val] of entries) console.log(`${key.padEnd(width)}  ${toCell(val)}`);
    return;
  }
  console.log(String(value));
}

/**
 * For content endpoints (`skills get`, `bots system get`, ...): text mode prints the raw
 * document so it can be piped into files or editors; `--json` keeps the API envelope.
 */
export function printContent(result: { content: string }, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const text = result.content;
  if (text) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}
