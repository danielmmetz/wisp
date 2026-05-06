// Minimal chat-flavored markdown renderer. Returns sanitized HTML safe for
// innerHTML — every byte from `input` is HTML-escaped exactly once, and
// rendered tags are produced by this module rather than passed through from
// the source.
//
// Supported syntax (Slack-flavored, single-character delimiters for
// emphasis):
//   *bold*    _italic_    ~strike~
//   `inline code`
//   ```fenced code blocks```
//   > blockquote (line-prefix; consecutive > lines fold into one block)
//   [text](url)
//   bare http(s) URL autolink
//
// URLs are restricted to http(s) and mailto. Anything else (javascript:,
// data:, etc.) falls back to literal text.
//
// Emphasis matches with word-boundary rules so common chat strings like
// `snake_case_var`, `a*b*c`, and `~/path` are NOT treated as markdown:
// the opener must be preceded by start-of-string or a non-word
// non-delimiter character, the body must not start or end with
// whitespace, and the closer must be followed by end-of-string or a
// non-word non-delimiter character.

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPE_MAP[c]!);
}

function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}

// In markdown links the user often writes a bare domain like
// `[foo](google.com)` and expects a clickable link. Promote those to
// https:// when the target obviously looks like a host (something.tld
// optionally followed by :port, /path, ?query, #fragment). Anything that
// already has a scheme — including non-http schemes that isSafeUrl will
// reject downstream — is returned as-is so we don't paper over a
// disallowed protocol.
function normalizeLinkUrl(url: string): string {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}([:/?#]|$)/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function anchor(url: string, text: string): string {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

// Already-rendered HTML fragments are pulled out of the string and replaced
// with placeholder tokens so later passes don't re-process their contents.
// Inline emphasis and the blockquote wrapper use sentinel-bracketed markers
// that survive escapeHtml unchanged and become real tags at the end. The
// two private-use code points are stripped from input first so a peer
// can't smuggle a fake placeholder into the output.
const PH_OPEN = "\uE000";
const PH_CLOSE = "\uE001";
const SENTINEL_RE = /[\uE000\uE001]/g;
const PLACEHOLDER_RE = /\uE000(\d+)\uE001/g;
const TAG_OPEN: Record<string, string> = {
  b: "<strong>",
  i: "<em>",
  d: "<del>",
  q: '<span class="quote">',
};
const TAG_CLOSE: Record<string, string> = {
  b: "</strong>",
  i: "</em>",
  d: "</del>",
  q: "</span>",
};
const TAG_RE = /\uE000([bidq])([se])\uE001/g;

const QS = `${PH_OPEN}qs${PH_CLOSE}`;
const QE = `${PH_OPEN}qe${PH_CLOSE}`;

// Slack-style emphasis: opener and closer must sit at "soft" boundaries
// (string ends or non-word non-delimiter chars) and the body must not
// start or end with whitespace OR the delimiter itself. Forbidding the
// delimiter at the body endpoints keeps doubled markers like `**foo**`
// from matching as bold-around-`*foo*` — they fall through as literal text.
const BOLD_RE = /(?<=^|[^*\w])\*([^\s*](?:[^\n*]*?[^\s*])?)\*(?=$|[^*\w])/g;
const ITALIC_RE = /(?<=^|[^_\w])_([^\s_](?:[^\n_]*?[^\s_])?)_(?=$|[^_\w])/g;
const STRIKE_RE = /(?<=^|[^~\w])~([^\s~](?:[^\n~]*?[^\s~])?)~(?=$|[^~\w])/g;

const QUOTE_LINE_RE = /^>(?: ?(.*))?$/;
// Slack-style multi-line quote: `>>>` at the start of a line begins a
// blockquote that absorbs the rest of that line and every subsequent line
// to end-of-message. Useful for pasting a long quote without per-line `>`.
const QUOTE_BIG_RE = /^>>>(?: ?(.*))?$/;

export function renderMarkdown(input: string): string {
  let s = input.replace(SENTINEL_RE, "");
  const stash: string[] = [];
  const stashHtml = (html: string): string => {
    const id = stash.push(html) - 1;
    return `${PH_OPEN}${id}${PH_CLOSE}`;
  };

  // Fenced code blocks first so their contents are immune to further parsing.
  // Both multi-line (```\ncode\n```) and single-line (```code```) forms
  // render as a code block; on the multi-line form the optional info
  // string before the first newline is stripped (we don't do syntax
  // highlighting).
  s = s.replace(/```([\s\S]*?)```/g, (_m, content: string) => {
    const nl = content.indexOf("\n");
    const code =
      nl >= 0 ? content.slice(nl + 1).replace(/\n+$/, "") : content;
    return stashHtml(`<code class="code-block">${escapeHtml(code)}</code>`);
  });

  // Inline code. Single line only — multi-line uses the fenced form above.
  s = s.replace(/`([^`\n]+?)`/g, (_m, code: string) =>
    stashHtml(`<code>${escapeHtml(code)}</code>`),
  );

  // Explicit markdown links. Stash before autolink so the URL inside the
  // parens isn't double-processed.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    const normalized = normalizeLinkUrl(url);
    if (!isSafeUrl(normalized)) return m;
    return stashHtml(anchor(normalized, text));
  });

  // Bare URL autolink. The outer regex grabs a generous run of non-space
  // characters; the post-match split peels off trailing punctuation that's
  // almost never part of a real URL ("see https://example.com." → period
  // stays as sentence punctuation, not part of the link).
  s = s.replace(/\bhttps?:\/\/\S+/g, (raw) => {
    const m = /^(.*?)([)\].,!?;:'"]*)$/.exec(raw);
    if (!m) return raw;
    const url = m[1]!;
    const trailing = m[2]!;
    if (!url || !isSafeUrl(url)) return raw;
    return stashHtml(anchor(url, url)) + trailing;
  });

  // Blockquotes: scan line-by-line and bracket runs of `> ` lines with
  // sentinel markers. Trailing/leading newlines around the markers are
  // collapsed so the block-level wrapper doesn't render an extra blank
  // line via pre-wrap on the parent.
  s = applyBlockquotes(s);

  // Inline emphasis. Markers use a private-use sentinel so they survive
  // the escapeHtml pass that follows.
  s = s.replace(STRIKE_RE, (_m, t: string) => `${PH_OPEN}ds${PH_CLOSE}${t}${PH_OPEN}de${PH_CLOSE}`);
  s = s.replace(BOLD_RE, (_m, t: string) => `${PH_OPEN}bs${PH_CLOSE}${t}${PH_OPEN}be${PH_CLOSE}`);
  s = s.replace(ITALIC_RE, (_m, t: string) => `${PH_OPEN}is${PH_CLOSE}${t}${PH_OPEN}ie${PH_CLOSE}`);

  s = escapeHtml(s);

  s = s.replace(TAG_RE, (_m, kind: string, side: string) =>
    side === "s" ? TAG_OPEN[kind]! : TAG_CLOSE[kind]!,
  );

  s = s.replace(PLACEHOLDER_RE, (_m, id: string) => stash[Number(id)] ?? "");

  return s;
}

function applyBlockquotes(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Triple-> wins over single-> on the same line; once seen it consumes
    // every remaining line so the user doesn't have to prefix each one.
    const big = QUOTE_BIG_RE.exec(line);
    if (big) {
      const inner: string[] = [big[1] ?? ""];
      i++;
      while (i < lines.length) {
        inner.push(lines[i]!);
        i++;
      }
      out.push(`${QS}${inner.join("\n")}${QE}`);
      break;
    }
    const m = QUOTE_LINE_RE.exec(line);
    if (m) {
      const inner: string[] = [m[1] ?? ""];
      i++;
      while (i < lines.length) {
        const m2 = QUOTE_LINE_RE.exec(lines[i]!);
        if (!m2) break;
        inner.push(m2[1] ?? "");
        i++;
      }
      out.push(`${QS}${inner.join("\n")}${QE}`);
    } else {
      out.push(line);
      i++;
    }
  }
  let result = out.join("\n");
  // The block-level quote wrapper introduces its own line break; drop any
  // adjacent source newline so pre-wrap doesn't render an extra empty row.
  result = result.split(`\n${QS}`).join(QS).split(`${QE}\n`).join(QE);
  return result;
}
