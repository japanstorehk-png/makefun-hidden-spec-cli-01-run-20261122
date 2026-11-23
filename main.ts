// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileInfo {
  lines: string[];
  br: string;
  final: boolean;
}

/** A file's lines and its own line break (SPEC.md section 3). */
function fileInfo(text: string): FileInfo {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

interface Piece {
  kind: string;
  text: string;
  /** For context lines: the index of the line within O. */
  oIndex?: number;
}

interface Match {
  tier: number;
  positions: number[];
}

function normalized(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? trimEndWS(s) : trimWS(s);
}

/** O at the first tier where it occurs at or after `from` (section 5). */
function findMatch(O: string[], file: string[], strict: boolean, from = 0, endOnly = false): Match | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= file.length; i += 1) {
      if (endOnly && i + O.length !== file.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (normalized(O[j]!, tier) !== normalized(file[i + j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** N replaces O's k matched lines at position `pos`; context lines come from the file. */
function replacement(N: Piece[], pos: number, file: string[], tier: number, pIndent: string): string[] {
  const fIndent = tier === 2 ? leadingWS(file[pos] ?? '') : '';
  const out: string[] = [];
  for (const pc of N) {
    if (pc.kind === ' ') {
      out.push(file[pos + (pc.oIndex ?? 0)] ?? pc.text);
    } else if (tier === 2 && pc.text.trim() !== '' && pc.text.startsWith(pIndent)) {
      out.push(fIndent + pc.text.slice(pIndent.length));
    } else {
      out.push(pc.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Successful move edits, in patch order, for the R lines of section 2. */
const moves: Array<{ from: string; to: string }> = [];

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinLines(lines, br, final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ section 5/7: SEARCH/REPLACE */

function replaceEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const N: Piece[] = newLines.map((text) => ({ kind: '+', text }));
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinLines(newLines, '\n', true));
      return;
    }
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const info = fileInfo(text);
    const m = findMatch(oldLines, info.lines, strict);
    if (m === null) throw new Fail('no-match', p);
    if (m.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = m.positions[0]!;
    const out = [...info.lines.slice(0, pos), ...replacement(N, pos, info.lines, m.tier, leadingWS(oldLines[0]!)), ...info.lines.slice(pos + oldLines.length)];
    tree.now.set(p, joinLines(out, info.br, info.final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = -1;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i + 1;
    let sep = i + 1;
    while (sep < lines.length && lines[sep]!.trimEnd() !== '=======') sep += 1;
    if (sep >= lines.length) throw new Exit2(`error: parse ${at}`);
    let end = sep + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (end >= lines.length) throw new Exit2(`error: parse ${at}`);
    let p = prevPath;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        p = t;
        break;
      }
    }
    if (p === null) throw new Exit2(`error: parse ${at}`);
    edits.push(replaceEdit(p, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/* --------------------------------------------------------------------- section 6: unified diffs */

interface RawHunk {
  a: number;
  body: Piece[];
  noAfterPlus: boolean;
  skip: boolean;
}

interface RawSection {
  oldDiff: string | null | undefined;
  newDiff: string | null | undefined;
  oldHeader: string | null | undefined;
  newHeader: string | null | undefined;
  oldRename: string | null | undefined;
  newRename: string | null | undefined;
  newFile: boolean;
  deletedFile: boolean;
  headerPair: boolean;
  hunks: RawHunk[];
}

function cleanPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isBodyStart(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
}

function hunkParts(h: RawHunk): { O: Piece[]; N: Piece[]; pIndent: string } {
  const O: Piece[] = [];
  const N: Piece[] = [];
  let oi = 0;
  for (const pc of h.body) {
    if (pc.kind === '\\') continue;
    if (pc.kind === ' ') {
      O.push({ kind: ' ', text: pc.text, oIndex: oi });
      N.push({ kind: ' ', text: pc.text, oIndex: oi });
      oi += 1;
    } else if (pc.kind === '-') {
      O.push({ kind: '-', text: pc.text });
      oi += 1;
    } else {
      N.push({ kind: '+', text: pc.text });
    }
  }
  return { O, N, pIndent: O.length > 0 ? leadingWS(O[0]!.text) : '' };
}

function applyHunks(s: RawSection, p: string, text: string, strict: boolean): string {
  const info = fileInfo(text);
  let lines = [...info.lines];
  let final = info.final;
  let d = 0;
  for (const h of s.hunks) {
    if (h.skip) continue;
    const { O, N, pIndent } = hunkParts(h);
    if (O.length > 0) {
      const m = findMatch(O.map((pc) => pc.text), lines, strict);
      if (m === null) throw new Fail('no-match', p);
      const want = h.a - 1 + d;
      let pos = m.positions[0]!;
      for (const candidate of m.positions) {
        if (Math.abs(candidate - want) < Math.abs(pos - want)) pos = candidate;
      }
      const atEnd = pos + O.length === lines.length;
      lines = [...lines.slice(0, pos), ...replacement(N, pos, lines, m.tier, pIndent), ...lines.slice(pos + O.length)];
      if (atEnd) final = !h.noAfterPlus;
      d += N.length - O.length;
    } else {
      const pos = Math.min(h.a + d, lines.length);
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...replacement(N, pos, lines, 0, pIndent));
      if (atEnd) final = !h.noAfterPlus;
      d += N.length;
    }
  }
  return joinLines(lines, info.br, final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let hunk: RawHunk | null = null;
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const fresh = (): RawSection => ({
    oldDiff: undefined, newDiff: undefined, oldHeader: undefined, newHeader: undefined,
    oldRename: undefined, newRename: undefined, newFile: false, deletedFile: false, headerPair: false, hunks: [],
  });
  const endHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === ' ' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
    let j = -1;
    for (let k = 0; k < hunk.body.length; k += 1) {
      if (hunk.body[k]!.kind === ' ' || hunk.body[k]!.kind === '+') j = k;
    }
    hunk.noAfterPlus = j >= 0 && hunk.body[j + 1]?.kind === '\\';
    hunk = null;
  };
  const deletion = (s: RawSection): boolean => s.newHeader === null || s.deletedFile;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (hunk !== null) {
      if (pairAt(i) || l.startsWith('diff --git ') || !isBodyStart(l)) {
        endHunk();
        continue;
      }
      const kind = l === '' ? ' ' : l[0]!;
      hunk.body.push({ kind, text: l === '' ? '' : l.slice(1) });
      i += 1;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.oldDiff = cleanPath(m[1]!);
      cur.newDiff = cleanPath(m[2]!);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (cur === null || cur.headerPair || cur.hunks.length > 0) {
        cur = fresh();
        sections.push(cur);
      }
      cur.oldHeader = cleanPath(l.slice(4));
      cur.newHeader = cleanPath(lines[i + 1]!.slice(4));
      cur.headerPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && !cur.headerPair && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null && !deletion(cur)) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: m === null ? 0 : Number(m[1]), body: [], noAfterPlus: false, skip: deletion(cur) };
      cur.hunks.push(hunk);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.oldRename = cleanPath(l.slice(12));
      else if (l.startsWith('rename to ')) cur.newRename = cleanPath(l.slice(10));
      else if (l.includes('new file mode')) cur.newFile = true;
      else if (l.includes('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  endHunk();

  const edits: Edit[] = [];
  for (const s of sections) {
    const old = s.oldHeader !== undefined ? s.oldHeader : s.oldRename !== undefined ? s.oldRename : s.oldDiff;
    const neu = s.newHeader !== undefined ? s.newHeader : s.newRename !== undefined ? s.newRename : s.newDiff;
    const paths: string[] = [];
    for (const p of [old, neu]) if (p !== null && p !== undefined) paths.push(p);
    const check = (tree: Tree): void => {
      for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
    };
    if (old === null || s.newFile) {
      const target = neu;
      edits.push((tree) => {
        check(tree);
        if (target === null || target === undefined) throw new Fail('missing', '');
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const created: string[] = [];
        let noNL = false;
        for (const h of s.hunks) {
          for (const pc of h.body) if (pc.kind === '+') created.push(pc.text);
        }
        for (let hi = s.hunks.length - 1; hi >= 0; hi -= 1) {
          const b = s.hunks[hi]!.body;
          let last = -1;
          for (let k = 0; k < b.length; k += 1) if (b[k]!.kind === '+') last = k;
          if (last >= 0) {
            noNL = b[last + 1]?.kind === '\\';
            break;
          }
        }
        tree.now.set(target, joinLines(created, '\n', !noNL));
      });
    } else if (neu === null || s.deletedFile) {
      const target = old ?? '';
      edits.push((tree) => {
        check(tree);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
    } else if (old !== undefined && neu !== undefined && old !== neu) {
      const from = old;
      const to = neu;
      edits.push((tree) => {
        check(tree);
        const text = tree.get(from);
        if (text === null) throw new Fail('missing', from);
        if (tree.get(to) !== null) throw new Fail('exists', to);
        const out = applyHunks(s, from, text, strict);
        tree.now.set(to, out);
        tree.now.set(from, null);
        moves.push({ from, to });
      });
    } else {
      const target = old ?? neu ?? '';
      edits.push((tree) => {
        check(tree);
        const text = tree.get(target);
        if (text === null) throw new Fail('missing', target);
        tree.now.set(target, applyHunks(s, target, text, strict));
      });
    }
  }
  return edits;
}

/* ------------------------------------------------------------------------- section 8: V4A patches */

interface V4Chunk {
  anchor: string | null;
  body: Piece[];
  eof: boolean;
  closed: boolean;
}

interface V4Section {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  addLines?: string[];
  moveTo?: string | null;
  chunks?: V4Chunk[];
}

function v4BodyStart(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
}

function v4SectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function applyV4Chunks(chunks: V4Chunk[], p: string, text: string, strict: boolean): string {
  const info = fileInfo(text);
  const lines = [...info.lines];
  let cursor = 0;
  for (const ch of chunks) {
    let tier = 0;
    if (ch.anchor !== null) {
      const m = findMatch([ch.anchor], lines, strict, cursor);
      if (m === null) throw new Fail('no-match', p);
      cursor = m.positions[0]! + 1;
    }
    const O: Piece[] = [];
    const N: Piece[] = [];
    let oi = 0;
    for (const pc of ch.body) {
      if (pc.kind === ' ') {
        O.push({ kind: ' ', text: pc.text, oIndex: oi });
        N.push({ kind: ' ', text: pc.text, oIndex: oi });
        oi += 1;
      } else if (pc.kind === '-') {
        O.push({ kind: '-', text: pc.text });
        oi += 1;
      } else {
        N.push({ kind: '+', text: pc.text });
      }
    }
    let pos: number;
    if (O.length === 0) {
      pos = ch.eof ? lines.length : cursor;
    } else {
      const m = findMatch(O.map((pc) => pc.text), lines, strict, cursor, ch.eof);
      if (m === null) throw new Fail('no-match', p);
      pos = m.positions[0]!;
      tier = m.tier;
    }
    const out = replacement(N, pos, lines, tier, O.length > 0 ? leadingWS(O[0]!.text) : '');
    lines.splice(pos, O.length, ...out);
    cursor = pos + out.length;
  }
  return joinLines(lines, info.br, info.final);
}

function v4Edits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4Section[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    if (v4SectionStart(l)) {
      const headerLine = i + 1;
      const kind: 'add' | 'delete' | 'update' = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      const path = l.slice(prefix.length).trim();
      i += 1;
      const body: Array<{ text: string; line: number }> = [];
      while (i < last && !v4SectionStart(lines[i]!)) {
        body.push({ text: lines[i]!, line: i + 1 });
        i += 1;
      }
      while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
      if (kind === 'add') {
        const addLines: string[] = [];
        for (const b of body) {
          if (b.text.startsWith('+')) addLines.push(b.text.slice(1));
          else if (b.text === '') addLines.push('');
          else throw new Exit2(`error: parse ${b.line}`);
        }
        sections.push({ kind, path, line: headerLine, addLines });
      } else if (kind === 'delete') {
        if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.line}`);
        sections.push({ kind, path, line: headerLine });
      } else {
        let moveTo: string | null = null;
        const chunks: V4Chunk[] = [];
        let current: V4Chunk | null = null;
        for (const b of body) {
          const t = b.text;
          if (t.trimEnd() === '*** End of File') {
            if (current === null) {
              current = { anchor: null, body: [], eof: true, closed: true };
              chunks.push(current);
            } else {
              current.eof = true;
              current.closed = true;
            }
            current = null;
          } else if (t.startsWith('@@')) {
            const anchor = t.slice(2).trim();
            current = { anchor: anchor === '' ? null : anchor, body: [], eof: false, closed: false };
            chunks.push(current);
          } else if (t.startsWith('*** Move to: ') && moveTo === null && chunks.length === 0) {
            moveTo = t.slice('*** Move to: '.length).trim();
          } else if (v4BodyStart(t)) {
            if (current === null) {
              if (chunks.length > 0) throw new Exit2(`error: parse ${b.line}`);
              current = { anchor: null, body: [], eof: false, closed: false };
              chunks.push(current);
            }
            current.body.push({ kind: t === '' ? ' ' : t[0]!, text: t === '' ? '' : t.slice(1) });
          } else {
            throw new Exit2(`error: parse ${b.line}`);
          }
        }
        if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
        sections.push({ kind, path, line: headerLine, moveTo, chunks });
      }
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const p = s.path;
    if (s.kind === 'add') {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinLines(s.addLines ?? [], '\n', true));
      });
    } else if (s.kind === 'delete') {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const to = s.moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (to !== null && to !== undefined && !safe(to)) throw new Fail('unsafe', to);
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        if (to !== null && to !== undefined && tree.get(to) !== null) throw new Fail('exists', to);
        const out = applyV4Chunks(s.chunks ?? [], p, text, strict);
        if (to !== null && to !== undefined) {
          tree.now.set(to, out);
          tree.now.set(p, null);
          moves.push({ from: p, to });
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  moves.length = 0;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4Edits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const claimed = new Set<string>();
  const renames: Array<{ from: string; to: string }> = [];
  for (const m of moves) {
    if (claimed.has(m.from) || claimed.has(m.to)) continue;
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      claimed.add(m.from);
      claimed.add(m.to);
      renames.push(m);
    }
  }
  if (!check) {
    for (const m of renames) {
      mkdirSync(dirname(m.to), { recursive: true });
      writeFileSync(m.to, tree.get(m.to)!);
      rmSync(m.from, { force: true });
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (claimed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const m of renames) rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
