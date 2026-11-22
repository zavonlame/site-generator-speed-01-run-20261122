// site-generator-speed-01-run-20261122: a fast drop-in for makefun-site 1.0.0.
//
// Same answers as makefun-site 1.0.0 on every case, byte for byte, but built for
// speed: templates are compiled once per case into plain JavaScript functions,
// Markdown is rendered in one fused pass (no token objects), inline HTML escaping
// works on whole runs instead of one character at a time, and slugs are memoised
// inside each run. Nothing is cached from one case to the next: every run(input)
// call builds all of its own state from scratch. No WebAssembly, no native code,
// no dependencies — plain JavaScript, Node 22.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped; plain text passes through untouched. */
const ESCAPE_TEST = /[&<>"']/;
function escapeHtml(text) {
  return ESCAPE_TEST.test(text) ? text.replace(ESCAPE_RE, (c) => ESCAPES[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

function slugAscii(s) {
  let out = '';
  let gap = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const ASCII_ONLY = /^[ -~]*$/;

/**
 * The slug of `text`, memoised in `memo` for this run: NFKD, combining marks
 * dropped, A-Z lowered, every run of characters other than a-z and 0-9 one "-",
 * none at either end, at most 64 characters (a "-" left at the cut dropped),
 * and "untitled" when nothing is left. Printable ASCII is already NFKD-normal
 * with no combining marks, so it takes the fast path.
 */
function slugify(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  const out = ASCII_ONLY.test(text) ? slugAscii(text) : slugAscii(text.normalize('NFKD').replace(/\p{M}/gu, ''));
  memo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * The words of a body: its runs of characters other than whitespace, counted
 * by one scan. Whitespace is exactly JavaScript's \s set: space, tab, newline,
 * carriage return, vertical tab and form feed, plus U+00A0, U+1680, U+2000–
 * U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. A surrogate pair
 * (one astral character) counts once, as its halves share one word.
 */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    else ws = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line.charCodeAt(0) === 35) continue;
    let allWs = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        allWs = false;
        break;
      }
    }
    if (allWs) continue;
    // key: value — the key is [a-z_]+ from position 0, then ':', then the end or ' ' + the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k === line.length - 1) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const WS = /\s/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return BLANK.test(line);
  if (c0 === 96) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The next special inline character from `from`, or -1. */
const INLINE_SPECIAL = /[\\`*\[]/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain text is
 * flushed in whole runs through the escaper: one regex scan finds the next
 * delimiter instead of walking the string one character at a time.
 */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) out += escapeHtml(s.slice(i, j));
    if (m === null) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        out += escapeHtml(s[j + 1]);
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        i = k + 1;
      } else {
        out += '*';
        i = j + 1;
      }
      continue;
    }
    const k = findUnescaped(s, ']', j + 1);
    const t = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = t === -1 ? '' : s.slice(k + 2, t);
    if (target !== '' && !WS.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
      i = t + 1;
    } else {
      out += '[';
      i = j + 1;
    }
  }
  return out;
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block on its own
 * lines, a "\n" after the last), its table of contents (every level 2 and 3
 * heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, memo) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;

  /** A list's HTML, its items gathered in one pass over the following lines. */
  const renderList = (isOrdered, first) => {
    const marker = isOrdered ? ORDERED : BULLET;
    const start = isOrdered ? Number(first[1]) : 1;
    const items = [];
    while (i < n) {
      const m = marker.exec(lines[i]);
      if (m !== null) {
        items.push(trimLine(isOrdered ? m[2] : m[1]));
        i++;
      } else if (CONTINUED.test(lines[i])) {
        items[items.length - 1] += `\n${trimLine(lines[i])}`;
        i++;
      } else break;
    }
    let s = isOrdered && start !== 1 ? `<ol start="${start}">\n` : isOrdered ? '<ol>\n' : '<ul>\n';
    for (let k = 0; k < items.length; k++) s += `<li>${inline(items[k], env)}</li>\n`;
    return s + (isOrdered ? '</ol>\n' : '</ul>\n');
  };

  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // blank (spaces/tabs only) is skipped; anything else is a paragraph below
      if (BLANK.test(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        let s = '<pre><code';
        if (fence[1] !== '') s += ` class="language-${escapeHtml(fence[1])}"`;
        s += '>';
        for (let k = 0; k < body.length; k++) s += `${escapeHtml(body[k])}\n`;
        out.push(`${s}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, memo), ids);
        const html = inline(heading.text, env);
        out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        out.push(renderList(false, bullet));
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        out.push(renderList(true, ordered));
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

let uid = 0;

/** JavaScript source for `nodes`, rendered into `O` from scope `sv` at include depth `dv`. */
function genNodes(nodes, sv, dv) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') code += `O.push(${JSON.stringify(n.text)});`;
    else if (n.kind === 'var') code += `O.push(X.esc(X.T(X.L(${sv},${JSON.stringify(n.path)}))));`;
    else if (n.kind === 'raw') code += `O.push(X.T(X.L(${sv},${JSON.stringify(n.path)})));`;
    else if (n.kind === 'if') {
      const cond = `X.R(X.L(${sv},${JSON.stringify(n.path)}))!==${n.not}`;
      code += `if(${cond}){${genNodes(n.then, sv, dv)}}`;
      if (n.else !== null) code += `else{${genNodes(n.else, sv, dv)}}`;
    } else if (n.kind === 'for') {
      const id = ++uid;
      const av = `a${id}`;
      const kv = `k${id}`;
      const vv = `v${id}`;
      const sv2 = `s${id}`;
      code += `{let ${av}=X.L(${sv},${JSON.stringify(n.path)});if(Array.isArray(${av})){for(let ${kv}=0;${kv}<${av}.length;${kv}++){let ${vv}={};${vv}[${JSON.stringify(n.name)}]=${av}[${kv}];${vv}.loop={index:${kv}+1,first:${kv}===0,last:${kv}===${av}.length-1,length:${av}.length};let ${sv2}={vars:${vv},parent:${sv}};${genNodes(n.body, sv2, dv)}}}}`;
    } else if (n.kind === 'include') {
      const id = ++uid;
      code += `{let f${id}=X.tpl.get(${JSON.stringify(n.name)});if(f${id}!==undefined&&${dv}<8)f${id}(${sv},X,${dv}+1,O);}`;
    }
  }
  return code;
}

/**
 * A template compiled to a function (S, X, D, O): the scope, the render context
 * ({ tpl, esc, L, T, R }), the include depth and the output array it appends to.
 */
function compileTemplate(name, src) {
  const body = genNodes(parseTemplate(name, src), 'S', 'D');
  return new Function('S', 'X', 'D', 'O', body);
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const memo = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const ctx = { tpl: templates, esc: escapeHtml, L: lookup, T: textOf, R: truthy };
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, memo), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, memo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name, memo);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, memo);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, memo);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  // The top scope's fixed names live in one shared parent scope, so each render
  // only builds its own small vars object instead of spreading the fixed names in.
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const fn = b.templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ vars, parent: baseScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return b.output;
}
