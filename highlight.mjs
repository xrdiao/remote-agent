// Syntax highlighting on the relay: shiki TextMate grammars + the desktop app's
// own theme JSON. Output is a compact payload (colour palette + per-line tokens)
// the phone renders as-is; every failure falls back to plain text.
import path from 'node:path';

const MAX_BYTES = 200 * 1024;
const MAX_LINES = 5000;

const LANG_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.ts': 'typescript', '.tsx': 'tsx', '.mts': 'typescript', '.cts': 'typescript',
  '.json': 'json', '.jsonc': 'jsonc',
  '.html': 'html', '.htm': 'html', '.vue': 'vue', '.svelte': 'svelte',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.md': 'markdown', '.mdx': 'mdx', '.txt': 'text', '.rst': 'rst',
  '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.sh': 'shellscript', '.bash': 'shellscript', '.zsh': 'shellscript', '.ps1': 'powershell',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.sql': 'sql',
  '.rb': 'ruby', '.php': 'php', '.lua': 'lua', '.zig': 'zig', '.gradle': 'groovy',
  '.dockerfile': 'dockerfile', '.gitignore': 'ignore',
};
const LANG_BY_NAME = {
  dockerfile: 'dockerfile', makefile: 'makefile', cmakelists: 'cmake',
};

export function langFor(filePath) {
  const base = path.basename(String(filePath)).toLowerCase();
  if (LANG_BY_NAME[base]) return LANG_BY_NAME[base];
  if (base === '.gitignore' || base === '.dockerignore' || base === '.npmignore') return 'ignore';
  return LANG_BY_EXT[path.extname(base)] || null;
}

let shikiMod = null;
let highlighter = null;
const loadedLangs = new Set();
const loadedThemes = new Map();

async function getHighlighter() {
  if (!highlighter) {
    shikiMod = shikiMod || await import('shiki');
    highlighter = await shikiMod.createHighlighter({ themes: [], langs: [] });
  }
  return highlighter;
}

async function ensureLang(h, lang) {
  if (loadedLangs.has(lang)) return;
  try {
    await h.loadLanguage(lang);
    loadedLangs.add(lang);
  } catch {
    loadedLangs.add(lang); // don't retry every file
    throw new Error(`no grammar for ${lang}`);
  }
}

// Theme registration keyed by content hash so theme-file edits are picked up.
async function ensureTheme(h, theme) {
  const key = `${theme.name}:${theme.fg}:${theme.tokenColors.length}:${JSON.stringify(theme.colors).length}`;
  if (!loadedThemes.has(key)) {
    const reg = { name: theme.name, type: theme.type === 'light' ? 'light' : 'dark', colors: theme.colors, fg: theme.fg, bg: theme.bg, tokenColors: theme.tokenColors, settings: theme.settings };
    await h.loadTheme(reg);
    loadedThemes.set(key, { ...reg, colors: theme.colors, file: theme.file });
  }
  return loadedThemes.get(key);
}

const STYLE = { bold: 1, italic: 2, underline: 4 };
function styleBits(fontStyle) {
  const s = String(fontStyle || '').toLowerCase();
  return (s.includes('bold') ? STYLE.bold : 0) | (s.includes('italic') ? STYLE.italic : 0) | (s.includes('underline') ? STYLE.underline : 0);
}

// editor colours → the fields the phone viewer needs (all sanitised client-side).
export function themeMeta(theme) {
  const c = theme.colors || {};
  const pick = (...keys) => keys.map(k => c[k]).find(v => typeof v === 'string' && v) || null;
  return {
    name: theme.name,
    type: theme.type === 'light' ? 'light' : 'dark',
    bg: pick('editor.background') || theme.bg || (theme.type === 'light' ? '#ffffff' : '#1e1e1e'),
    fg: pick('editor.foreground') || theme.fg || (theme.type === 'light' ? '#000000' : '#d4d4d4'),
    lineNo: pick('editorLineNumber.foreground'),
    lineNoActive: pick('editorLineNumber.activeForeground'),
    selection: pick('editor.selectionBackground'),
    addBg: pick('diffEditor.insertedTextBackground', 'diffEditor.insertedLineBackground'),
    delBg: pick('diffEditor.removedTextBackground', 'diffEditor.removedLineBackground'),
    modBg: pick('diffEditor.modifiedTextBackground', 'diffEditor.modifiedLineBackground'),
    gutterAdd: pick('editorGutter.addedBackground', 'diffEditorGutter.insertedLineBackground'),
    gutterMod: pick('editorGutter.modifiedBackground', 'diffEditorGutter.modifiedLineBackground'),
    gutterDel: pick('editorGutter.deletedBackground', 'diffEditorGutter.removedLineBackground'),
  };
}

// Turns a shiki token tree into the compact wire format:
// theme + palette + lines [[ [text, paletteIndex|-1, styleBits], ...], ...]
export function packTokens(tokenLines, theme) {
  const meta = themeMeta(theme);
  const palette = [];
  const index = new Map();
  const idx = hex => {
    const k = String(hex).toLowerCase();
    if (index.has(k)) return index.get(k);
    index.set(k, palette.length);
    palette.push(hex);
    return index.size - 1;
  };
  const lines = tokenLines.map(line => {
    const out = [];
    for (const t of line) {
      const color = t.color && t.color.toLowerCase() !== (meta.fg || '').toLowerCase() ? idx(t.color) : -1;
      const bits = styleBits(t.fontStyle);
      const last = out[out.length - 1];
      if (last && last[1] === color && last[2] === bits) last[0] += t.content;
      else out.push([t.content, color, bits]);
    }
    return out;
  });
  return { theme: meta, palette, lines };
}

// Main entry: file text + resolved theme → hl payload, or null when the file is
// too big / language unknown / shiki fails (caller then sends plain text).
export async function highlightText(text, filePath, theme) {
  if (!text || text.length > MAX_BYTES) return null;
  const lineCount = (text.match(/\n/g) || []).length + 1;
  if (lineCount > MAX_LINES) return null;
  const lang = langFor(filePath);
  if (!lang || !theme) return null;
  try {
    const h = await getHighlighter();
    await ensureLang(h, lang);
    const reg = await ensureTheme(h, theme);
    const tokens = h.codeToTokens(text.replace(/\r/g, ''), { lang, theme: reg });
    return { lang, ...packTokens(tokens.tokens, reg) };
  } catch {
    return null;
  }
}
