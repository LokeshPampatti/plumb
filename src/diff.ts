import type { DiffLine, FileChange, Hunk } from './types.js';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function unquote(p: string): string {
  // git quotes paths with unusual characters: "a/some\tfile"
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  }
  return p;
}

function stripPrefix(p: string): string {
  p = unquote(p.trim());
  if (p === '/dev/null') return p;
  return p.replace(/^[ab]\//, '');
}

/** Parse `git diff` unified output (with or without --no-prefix). */
export function parseUnifiedDiff(text: string): FileChange[] {
  const files: FileChange[] = [];
  let cur: FileChange | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git (?:"a\/(.+?)"|a\/(\S+)) (?:"b\/(.+?)"|b\/(.+))$/);
      const oldP = m ? (m[1] ?? m[2]) : '';
      const newP = m ? (m[3] ?? m[4]) : '';
      cur = {
        path: newP,
        oldPath: oldP !== newP ? oldP : undefined,
        status: 'modified',
        binary: false,
        hunks: [],
        added: new Set(),
        removed: new Set(),
      };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;

    if (!hunk) {
      if (line.startsWith('new file mode')) cur.status = 'added';
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        cur.status = 'renamed';
        cur.oldPath = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) cur.path = line.slice('rename to '.length);
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) cur.binary = true;
      else if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4));
        if (p === '/dev/null') cur.status = 'added';
        else if (cur.status !== 'renamed') cur.oldPath = p !== cur.path ? p : cur.oldPath;
      } else if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4));
        if (p === '/dev/null') cur.status = 'deleted';
        else cur.path = p;
      }
    }

    const hm = line.match(HUNK_RE);
    if (hm) {
      hunk = {
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        header: hm[5].trim(),
        lines: [],
      };
      cur.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) continue;

    const tag = line[0];
    const body = line.slice(1);
    let dl: DiffLine | null = null;
    if (tag === '+') {
      dl = { type: 'add', text: body, newNo: newNo };
      cur.added.add(newNo);
      newNo++;
    } else if (tag === '-') {
      dl = { type: 'del', text: body, oldNo: oldNo };
      cur.removed.add(oldNo);
      oldNo++;
    } else if (tag === ' ') {
      dl = { type: 'ctx', text: body, oldNo: oldNo, newNo: newNo };
      oldNo++;
      newNo++;
    } else if (tag === '\\') {
      continue; // "\ No newline at end of file"
    } else if (line === '' && i === lines.length - 1) {
      continue;
    } else if (line === '') {
      // Some tools strip the leading space from empty context lines.
      dl = { type: 'ctx', text: '', oldNo: oldNo, newNo: newNo };
      oldNo++;
      newNo++;
    } else {
      hunk = null;
      continue;
    }
    hunk.lines.push(dl);
  }
  return files;
}

/** Build a synthetic "added file" change for an untracked file. */
export function addedFileChange(path: string, content: string): FileChange {
  const textLines = content.split('\n');
  if (textLines[textLines.length - 1] === '') textLines.pop();
  const lines: DiffLine[] = textLines.map((t, i) => ({ type: 'add', text: t, newNo: i + 1 }));
  return {
    path,
    status: 'added',
    binary: false,
    hunks: textLines.length
      ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: textLines.length, header: '', lines }]
      : [],
    added: new Set(lines.map((l) => l.newNo!)),
    removed: new Set(),
  };
}

/** New-side line numbers visible in the diff (added + context). GitHub only accepts comments on these. */
export function commentableLines(fc: FileChange): Set<number> {
  const s = new Set<number>();
  for (const h of fc.hunks) for (const l of h.lines) if (l.newNo !== undefined) s.add(l.newNo);
  return s;
}

export function changedLineCount(files: FileChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added.size;
    removed += f.removed.size;
  }
  return { added, removed };
}

/** Render one file's hunks back to unified-diff text with explicit new-side line numbers. */
export function renderNumberedDiff(fc: FileChange, maxLines = 400): string {
  const out: string[] = [];
  let count = 0;
  for (const h of fc.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.header}`);
    for (const l of h.lines) {
      if (count++ >= maxLines) {
        out.push(`... (${fc.added.size + fc.removed.size} changed lines total, truncated)`);
        return out.join('\n');
      }
      const no = l.newNo !== undefined ? String(l.newNo).padStart(5) : '     ';
      const tag = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      out.push(`${no} ${tag} ${l.text}`);
    }
  }
  return out.join('\n');
}
