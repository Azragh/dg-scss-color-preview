const vscode = require('vscode');
const path = require('path');

let output;
let heavyRefreshTimer = null;
let lightRefreshTimer = null;
let decorationCache = new Map();
let editorDecorationState = new WeakMap();
let latestWorkspaceState = {
  tokenMap: new Map(),
  parsedFiles: 0,
  errors: []
};

function activate(context) {
  output = vscode.window.createOutputChannel('SCSS Color Preview');

  const refresh = () => scheduleHeavyRefresh('manual');

  context.subscriptions.push(
    vscode.commands.registerCommand('scssColorPreview.refresh', refresh),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isSupportedDocument(e.document)) return;
      scheduleHeavyRefresh(`change:${path.basename(e.document.fileName)}`);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!isSupportedDocument(doc)) return;
      scheduleHeavyRefresh(`open:${path.basename(doc.fileName)}`);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !isSupportedDocument(editor.document)) return;
      scheduleLightRefresh('active-editor');
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      if (!editors.some((editor) => isSupportedDocument(editor.document))) return;
      scheduleLightRefresh('visible-editors');
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleHeavyRefresh('workspace-folders')),
    { dispose: disposeDecorationCache },
    output
  );

  scheduleHeavyRefresh('activate');
}

function deactivate() {
  disposeDecorationCache();
}

function disposeDecorationCache() {
  for (const type of decorationCache.values()) {
    try { type.dispose(); } catch {}
  }
  decorationCache.clear();
}

function isSupportedDocument(document) {
  return !!document && ['scss', 'sass', 'css'].includes(document.languageId);
}

function getVisibleStyleEditors() {
  return vscode.window.visibleTextEditors.filter((editor) => isSupportedDocument(editor.document));
}

function scheduleHeavyRefresh(reason) {
  if (!vscode.workspace.getConfiguration('scssColorPreview').get('enabled', true)) {
    clearDecorations();
    return;
  }

  if (heavyRefreshTimer) clearTimeout(heavyRefreshTimer);

  heavyRefreshTimer = setTimeout(async () => {
    try {
      await fullRefresh(reason, { rebuildState: true });
    } catch (err) {
      output.appendLine(`[error] ${String(err && err.stack ? err.stack : err)}`);
    }
  }, 450);
}

function scheduleLightRefresh(reason) {
  if (!vscode.workspace.getConfiguration('scssColorPreview').get('enabled', true)) {
    clearDecorations();
    return;
  }

  if (lightRefreshTimer) clearTimeout(lightRefreshTimer);

  lightRefreshTimer = setTimeout(() => {
    try {
      applyLatestStateToVisibleEditors(reason);
    } catch (err) {
      output.appendLine(`[error] ${String(err && err.stack ? err.stack : err)}`);
    }
  }, 120);
}

async function fullRefresh(reason, options = {}) {
  const { rebuildState = true } = options;
  const editors = getVisibleStyleEditors();
  if (!editors.length) return;

  if (rebuildState) {
    output.clear();
    output.appendLine(`SCSS Color Preview refresh: ${reason}`);

    latestWorkspaceState = await buildWorkspaceState();
    output.appendLine(`Parsed files: ${latestWorkspaceState.parsedFiles}`);
    output.appendLine(`Resolved tokens: ${latestWorkspaceState.tokenMap.size}`);
    if (latestWorkspaceState.errors.length) {
      output.appendLine('Errors:');
      latestWorkspaceState.errors.forEach((e) => output.appendLine(`- ${e}`));
    }
  }

  applyLatestStateToVisibleEditors(reason);
}

function applyLatestStateToVisibleEditors(reason = 'light') {
  const editors = getVisibleStyleEditors();
  if (!editors.length) return;

  for (const editor of editors) {
    applyDecorations(editor, latestWorkspaceState.tokenMap);
  }
}

function clearDecorations() {
  for (const editor of vscode.window.visibleTextEditors) {
    clearEditorDecorations(editor);
  }
}

async function buildWorkspaceState() {
  const tokenMap = new Map();
  const rawScss = new Map();
  const rawCss = new Map();
  const errors = [];
  const maxFiles = Number(vscode.workspace.getConfiguration('scssColorPreview').get('maxFiles', 300));

  const files = await vscode.workspace.findFiles('**/*.{scss,sass,css}', '**/{node_modules,.git,dist,build,.next,.nuxt,vendor}/**', maxFiles);

  for (const uri of files) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = stripComments(doc.getText());
      collectAssignments(text, rawScss, rawCss);
    } catch (err) {
      errors.push(`${uri.fsPath}: ${String(err.message || err)}`);
    }
  }

  const resolver = createResolver(rawScss, rawCss, errors);

  for (const key of rawScss.keys()) {
    const color = resolver.resolveScss(key);
    if (color) tokenMap.set(`$${key}`, colorToCss(color));
  }

  for (const key of rawCss.keys()) {
    const color = resolver.resolveCss(key);
    if (color) tokenMap.set(`--${key}`, colorToCss(color));
  }

  return { tokenMap, parsedFiles: files.length, errors };
}

function collectAssignments(text, rawScss, rawCss) {
  const scssRegex = /\$([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  const cssRegex = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = scssRegex.exec(text)) !== null) rawScss.set(m[1], m[2].trim());
  while ((m = cssRegex.exec(text)) !== null) rawCss.set(m[1], m[2].trim());
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function createResolver(rawScss, rawCss, errors) {
  const scssMemo = new Map();
  const cssMemo = new Map();
  const scssStack = new Set();
  const cssStack = new Set();

  function resolveScss(name) {
    if (scssMemo.has(name)) return scssMemo.get(name);
    if (scssStack.has(name)) return null;
    scssStack.add(name);
    const expr = rawScss.get(name);
    const result = expr ? evaluateExpression(expr, { resolveScss, resolveCss }) : null;
    if (result) scssMemo.set(name, result);
    scssStack.delete(name);
    return result;
  }

  function resolveCss(name) {
    if (cssMemo.has(name)) return cssMemo.get(name);
    if (cssStack.has(name)) return null;
    cssStack.add(name);
    const expr = rawCss.get(name);
    const result = expr ? evaluateExpression(expr, { resolveScss, resolveCss }) : null;
    if (result) cssMemo.set(name, result);
    cssStack.delete(name);
    return result;
  }

  return { resolveScss, resolveCss };
}


function applyDecorations(editor, tokenMap) {
  const text = editor.document.getText();
  const grouped = new Map();
  const claimedRanges = new Map();

  addGroupedDecorationsFromRegex(
    editor,
    text,
    /(\$[a-zA-Z0-9_-]+|--[a-zA-Z0-9_-]+)/g,
    (token) => tokenMap.get(token),
    grouped,
    claimedRanges,
    100
  );

  addLiteralDecorations(editor, text, grouped, claimedRanges);

  const previousColors = editorDecorationState.get(editor) || new Set();
  const nextColors = new Set(grouped.keys());

  for (const [color, decorations] of grouped.entries()) {
    editor.setDecorations(getDecorationType(color), decorations);
  }

  for (const color of previousColors) {
    if (!nextColors.has(color)) {
      const type = decorationCache.get(color);
      if (type) editor.setDecorations(type, []);
    }
  }

  editorDecorationState.set(editor, nextColors);
}

function clearEditorDecorations(editor) {
  const previousColors = editorDecorationState.get(editor) || new Set();
  for (const color of previousColors) {
    const type = decorationCache.get(color);
    if (type) editor.setDecorations(type, []);
  }
  editorDecorationState.delete(editor);
}

function addGroupedDecorationsFromRegex(editor, text, regex, colorGetter, grouped, claimedRanges, priority = 0) {
  let match;
  while ((match = regex.exec(text)) !== null) {
    const token = match[0];
    const color = colorGetter(token);
    if (!color) continue;

    addDecoration(editor, grouped, claimedRanges, match.index, token.length, color, `${token} → ${color}`, priority);
  }
}

function addLiteralDecorations(editor, text, grouped, claimedRanges) {
  const literalPatterns = [
    /#[0-9a-fA-F]{3,8}\b/g,
    /\brgba?\(\s*[^)\n]+\)/gi,
    /\bhsla?\(\s*[^)\n]+\)/gi,
    /\boklab\(\s*[^)\n]+\)/gi,
    /\boklch\(\s*[^)\n]+\)/gi
  ];

  for (const regex of literalPatterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const literal = match[0];
      const color = parseLiteralColorForDecoration(literal);
      if (!color) continue;
      if (isInsideIdentifier(text, match.index, literal.length)) continue;
      addDecoration(editor, grouped, claimedRanges, match.index, literal.length, color, `${literal}`, 10);
    }
  }

  const nameRegex = new RegExp(`(?<![a-zA-Z0-9_$-])(${CSS_COLOR_KEYWORDS.join('|')})(?![a-zA-Z0-9_-])`, 'gi');
  let nameMatch;
  while ((nameMatch = nameRegex.exec(text)) !== null) {
    const literal = nameMatch[0];
    const colorObj = parseNamedColor(literal);
    if (!colorObj) continue;
    const color = colorToCss(colorObj);
    addDecoration(editor, grouped, claimedRanges, nameMatch.index, literal.length, color, `${literal} → ${color}`, 5);
  }
}

function addDecoration(editor, grouped, claimedRanges, startIndex, length, color, hoverMessage, priority) {
  const key = `${startIndex}:${startIndex + length}`;
  const existing = claimedRanges.get(key);
  if (existing && existing.priority > priority) return;
  if (existing && existing.priority === priority && existing.color === color) return;

  if (existing) {
    const arr = grouped.get(existing.color);
    if (arr) {
      const idx = arr.findIndex((item) => {
        const s = editor.document.offsetAt(item.range.start);
        const e = editor.document.offsetAt(item.range.end);
        return `${s}:${e}` === key;
      });
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  const range = new vscode.Range(
    editor.document.positionAt(startIndex),
    editor.document.positionAt(startIndex + length)
  );

  if (!grouped.has(color)) grouped.set(color, []);
  grouped.get(color).push({ range, hoverMessage });
  claimedRanges.set(key, { color, priority });
}

function isInsideIdentifier(text, index, length) {
  const before = index > 0 ? text[index - 1] : '';
  const after = index + length < text.length ? text[index + length] : '';
  return /[a-zA-Z0-9_$-]/.test(before || '') || /[a-zA-Z0-9_-]/.test(after || '');
}

function parseLiteralColorForDecoration(literal) {
  literal = String(literal).trim();
  const hex = parseHex(literal);
  if (hex) return colorToCss(hex);

  const rgb = parseRgbFunc(literal);
  if (rgb) return colorToCss(rgb);

  const hsl = parseHslFunc(literal);
  if (hsl) return colorToCss(hsl);

  const oklab = parseOklabFunc(literal);
  if (oklab) return colorToCss(oklab);

  const oklch = parseOklchFunc(literal);
  if (oklch) return colorToCss(oklch);

  const named = parseNamedColor(literal);
  if (named) return colorToCss(named);

  return null;
}


function getDecorationType(color) {
  if (decorationCache.has(color)) return decorationCache.get(color);

  const type = vscode.window.createTextEditorDecorationType({
    backgroundColor: toSoftBackground(color),
    borderRadius: '2px',
    borderWidth: '0 0 2px 0',
    borderStyle: 'solid',
    borderColor: color,
    overviewRulerColor: color,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });

  decorationCache.set(color, type);
  return type;
}

function toSoftBackground(color) {
  const m = String(color).match(/^rgb\((\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?\)$/i);
  if (!m) return 'rgba(255,255,255,0.04)';
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  return `rgba(${r}, ${g}, ${b}, 0.12)`;
}

function evaluateExpression(expr, ctx) {
  expr = expr.trim();
  expr = expr.replace(/^#\{\s*(\$[a-zA-Z0-9_-]+|--[a-zA-Z0-9_-]+)\s*\}$/, '$1');

  const hex = parseHex(expr);
  if (hex) return hex;

  const named = parseNamedColor(expr);
  if (named) return named;

  if (/^\$[a-zA-Z0-9_-]+$/.test(expr)) return ctx.resolveScss(expr.slice(1));
  if (/^--[a-zA-Z0-9_-]+$/.test(expr)) return ctx.resolveCss(expr.slice(2));

  const varMatch = expr.match(/^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,[^)]+)?\)$/i);
  if (varMatch) return ctx.resolveCss(varMatch[1].slice(2));

  const mixMatch = expr.match(/^(?:color\.)?mix\((.*)\)$/i);
  if (mixMatch) {
    const args = splitArgs(mixMatch[1]);
    if (args.length >= 2) {
      const c1 = evaluateExpression(cleanWeightArg(args[0]), ctx);
      const c2 = evaluateExpression(cleanWeightArg(args[1]), ctx);
      const weightArg = args.find((a, i) => i >= 2 && /weight/i.test(a)) || args[2] || '50%';
      const weight = parsePercent(weightArg);
      if (c1 && c2 && weight !== null) return mixColors(c1, c2, weight / 100);
    }
  }

  const tintMatch = expr.match(/^tint\((.*)\)$/i);
  if (tintMatch) {
    const args = splitArgs(tintMatch[1]);
    if (args.length >= 2) {
      const color = evaluateExpression(args[0], ctx);
      const pct = parsePercent(args[1]);
      if (color && pct !== null) return mixColors(hexToColor('#ffffff'), color, pct / 100);
    }
  }

  const shadeMatch = expr.match(/^shade\((.*)\)$/i);
  if (shadeMatch) {
    const args = splitArgs(shadeMatch[1]);
    if (args.length >= 2) {
      const color = evaluateExpression(args[0], ctx);
      const pct = parsePercent(args[1]);
      if (color && pct !== null) return mixColors(hexToColor('#000000'), color, pct / 100);
    }
  }

  const alphaMatch = expr.match(/^alpha\((.*)\)$/i);
  if (alphaMatch) {
    const args = splitArgs(alphaMatch[1]);
    if (args.length >= 2) {
      const color = evaluateExpression(args[0], ctx);
      const alpha = parseNumber(args[1]);
      if (color && alpha !== null) return { ...color, a: clamp(alpha, 0, 1) };
    }
  }

  const oklab = parseOklabFunc(expr);
  if (oklab) return oklab;

  const oklch = parseOklchFunc(expr);
  if (oklch) return oklch;

  const rgbaVar = parseRgbLikeWithContext(expr, ctx);
  if (rgbaVar) return rgbaVar;

  const hslFromMatch = expr.match(/^hsl\(\s*from\s+var\(\s*(--[a-zA-Z0-9_-]+)\s*\)\s+h\s+(calc\([^)]*\)|s|[\d.%-]+)\s+(calc\([^)]*\)|l|[\d.%-]+)\s*\)$/i);
  if (hslFromMatch) {
    const base = ctx.resolveCss(hslFromMatch[1].slice(2));
    if (base) {
      const hsl = rgbToHsl(base);
      const s = resolveRelativeChannel(hsl.s, hslFromMatch[2], true);
      const l = resolveRelativeChannel(hsl.l, hslFromMatch[3], true);
      return hslToRgb(hsl.h, s, l, base.a ?? 1);
    }
  }

  const rgbFromMatch = expr.match(/^rgb\(\s*from\s+var\(\s*(--[a-zA-Z0-9_-]+)\s*\)\s+r\s+g\s+b\s*\/\s*([\d.]+)\s*\)$/i);
  if (rgbFromMatch) {
    const base = ctx.resolveCss(rgbFromMatch[1].slice(2));
    if (base) return { ...base, a: clamp(parseFloat(rgbFromMatch[2]), 0, 1) };
  }

  const rgba = parseRgbFunc(expr);
  if (rgba) return rgba;
  const hsla = parseHslFunc(expr);
  if (hsla) return hsla;

  return null;
}

function cleanWeightArg(arg) {
  return arg.replace(/\$weight\s*:/i, '').trim();
}

function splitArgs(input) {
  const args = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function parseHex(value) {
  const m = value.match(/^#([0-9a-f]{3,8})$/i);
  if (!m) return null;
  return hexToColor(`#${m[1]}`);
}

function hexToColor(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('') + 'ff';
  else if (h.length === 4) h = h.split('').map((c) => c + c).join('');
  else if (h.length === 6) h += 'ff';
  else if (h.length !== 8) return null;
  const n = parseInt(h, 16);
  return {
    r: (n >> 24) & 255,
    g: (n >> 16) & 255,
    b: (n >> 8) & 255,
    a: Math.round(((n & 255) / 255) * 1000) / 1000
  };
}

const CSS_NAMED_COLORS = {
  "aliceblue": "#f0f8ff",
  "antiquewhite": "#faebd7",
  "aqua": "#00ffff",
  "aquamarine": "#7fffd4",
  "azure": "#f0ffff",
  "beige": "#f5f5dc",
  "bisque": "#ffe4c4",
  "black": "#000000",
  "blanchedalmond": "#ffebcd",
  "blue": "#0000ff",
  "blueviolet": "#8a2be2",
  "brown": "#a52a2a",
  "burlywood": "#deb887",
  "cadetblue": "#5f9ea0",
  "chartreuse": "#7fff00",
  "chocolate": "#d2691e",
  "coral": "#ff7f50",
  "cornflowerblue": "#6495ed",
  "cornsilk": "#fff8dc",
  "crimson": "#dc143c",
  "cyan": "#00ffff",
  "darkblue": "#00008b",
  "darkcyan": "#008b8b",
  "darkgoldenrod": "#b8860b",
  "darkgray": "#a9a9a9",
  "darkgreen": "#006400",
  "darkgrey": "#a9a9a9",
  "darkkhaki": "#bdb76b",
  "darkmagenta": "#8b008b",
  "darkolivegreen": "#556b2f",
  "darkorange": "#ff8c00",
  "darkorchid": "#9932cc",
  "darkred": "#8b0000",
  "darksalmon": "#e9967a",
  "darkseagreen": "#8fbc8f",
  "darkslateblue": "#483d8b",
  "darkslategray": "#2f4f4f",
  "darkslategrey": "#2f4f4f",
  "darkturquoise": "#00ced1",
  "darkviolet": "#9400d3",
  "deeppink": "#ff1493",
  "deepskyblue": "#00bfff",
  "dimgray": "#696969",
  "dimgrey": "#696969",
  "dodgerblue": "#1e90ff",
  "firebrick": "#b22222",
  "floralwhite": "#fffaf0",
  "forestgreen": "#228b22",
  "fuchsia": "#ff00ff",
  "gainsboro": "#dcdcdc",
  "ghostwhite": "#f8f8ff",
  "gold": "#ffd700",
  "goldenrod": "#daa520",
  "gray": "#808080",
  "green": "#008000",
  "greenyellow": "#adff2f",
  "grey": "#808080",
  "honeydew": "#f0fff0",
  "hotpink": "#ff69b4",
  "indianred": "#cd5c5c",
  "indigo": "#4b0082",
  "ivory": "#fffff0",
  "khaki": "#f0e68c",
  "lavender": "#e6e6fa",
  "lavenderblush": "#fff0f5",
  "lawngreen": "#7cfc00",
  "lemonchiffon": "#fffacd",
  "lightblue": "#add8e6",
  "lightcoral": "#f08080",
  "lightcyan": "#e0ffff",
  "lightgoldenrodyellow": "#fafad2",
  "lightgray": "#d3d3d3",
  "lightgreen": "#90ee90",
  "lightgrey": "#d3d3d3",
  "lightpink": "#ffb6c1",
  "lightsalmon": "#ffa07a",
  "lightseagreen": "#20b2aa",
  "lightskyblue": "#87cefa",
  "lightslategray": "#778899",
  "lightslategrey": "#778899",
  "lightsteelblue": "#b0c4de",
  "lightyellow": "#ffffe0",
  "lime": "#00ff00",
  "limegreen": "#32cd32",
  "linen": "#faf0e6",
  "magenta": "#ff00ff",
  "maroon": "#800000",
  "mediumaquamarine": "#66cdaa",
  "mediumblue": "#0000cd",
  "mediumorchid": "#ba55d3",
  "mediumpurple": "#9370db",
  "mediumseagreen": "#3cb371",
  "mediumslateblue": "#7b68ee",
  "mediumspringgreen": "#00fa9a",
  "mediumturquoise": "#48d1cc",
  "mediumvioletred": "#c71585",
  "midnightblue": "#191970",
  "mintcream": "#f5fffa",
  "mistyrose": "#ffe4e1",
  "moccasin": "#ffe4b5",
  "navajowhite": "#ffdead",
  "navy": "#000080",
  "oldlace": "#fdf5e6",
  "olive": "#808000",
  "olivedrab": "#6b8e23",
  "orange": "#ffa500",
  "orangered": "#ff4500",
  "orchid": "#da70d6",
  "palegoldenrod": "#eee8aa",
  "palegreen": "#98fb98",
  "paleturquoise": "#afeeee",
  "palevioletred": "#db7093",
  "papayawhip": "#ffefd5",
  "peachpuff": "#ffdab9",
  "peru": "#cd853f",
  "pink": "#ffc0cb",
  "plum": "#dda0dd",
  "powderblue": "#b0e0e6",
  "purple": "#800080",
  "rebeccapurple": "#663399",
  "red": "#ff0000",
  "rosybrown": "#bc8f8f",
  "royalblue": "#4169e1",
  "saddlebrown": "#8b4513",
  "salmon": "#fa8072",
  "sandybrown": "#f4a460",
  "seagreen": "#2e8b57",
  "seashell": "#fff5ee",
  "sienna": "#a0522d",
  "silver": "#c0c0c0",
  "skyblue": "#87ceeb",
  "slateblue": "#6a5acd",
  "slategray": "#708090",
  "slategrey": "#708090",
  "snow": "#fffafa",
  "springgreen": "#00ff7f",
  "steelblue": "#4682b4",
  "tan": "#d2b48c",
  "teal": "#008080",
  "thistle": "#d8bfd8",
  "tomato": "#ff6347",
  "transparent": "#00000000",
  "turquoise": "#40e0d0",
  "violet": "#ee82ee",
  "wheat": "#f5deb3",
  "white": "#ffffff",
  "whitesmoke": "#f5f5f5",
  "yellow": "#ffff00",
  "yellowgreen": "#9acd32"
};
const CSS_COLOR_KEYWORDS = Object.keys(CSS_NAMED_COLORS).sort((a, b) => b.length - a.length);

function parseNamedColor(value) {
  const hex = CSS_NAMED_COLORS[String(value).toLowerCase()];
  return hex ? hexToColor(hex) : null;
}

function parseRgbFunc(value) {
  const m = value.match(/^rgba?\((.*)\)$/i);
  if (!m) return null;
  const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const r = clamp(parseFloat(parts[0]), 0, 255);
  const g = clamp(parseFloat(parts[1]), 0, 255);
  const b = clamp(parseFloat(parts[2]), 0, 255);
  const a = parts[3] != null ? clamp(parseFloat(parts[3]), 0, 1) : 1;
  if ([r, g, b, a].some(Number.isNaN)) return null;
  return { r, g, b, a };
}

function parseHslFunc(value) {
  const m = value.match(/^hsla?\((.*)\)$/i);
  if (!m) return null;
  const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = parseHueValue(parts[0]);
  const s = parsePercentValue(parts[1]);
  const l = parsePercentValue(parts[2]);
  const a = parts[3] != null ? parseAlphaValue(parts[3]) : 1;
  if ([h, s, l, a].some((v) => v === null || Number.isNaN(v))) return null;
  return hslToRgb(h, s, l, a);
}

function parseRgbLikeWithContext(value, ctx) {
  const m = value.match(/^rgba?\((.*)\)$/i);
  if (!m) return null;
  const inner = m[1].trim();

  const commaArgs = splitArgs(inner);
  if (commaArgs.length === 1) {
    const base = evaluateExpression(commaArgs[0], ctx);
    if (base) return base;
  }
  if (commaArgs.length === 2) {
    const base = evaluateExpression(commaArgs[0], ctx);
    const alpha = parseAlphaValue(commaArgs[1]);
    if (base && alpha !== null) return { ...base, a: alpha };
  }

  const slashParts = splitTopLevelBySlash(inner);
  if (slashParts.length === 2) {
    const base = evaluateExpression(slashParts[0], ctx);
    const alpha = parseAlphaValue(slashParts[1]);
    if (base && alpha !== null) return { ...base, a: alpha };
  }

  return null;
}

function splitTopLevelBySlash(input) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === '/' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseOklabFunc(value) {
  const m = value.match(/^oklab\((.*)\)$/i);
  if (!m) return null;
  const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const L = parseUnitInterval(parts[0]);
  const a = parseFloat(parts[1]);
  const b = parseFloat(parts[2]);
  const alpha = parts[3] != null ? parseAlphaValue(parts[3]) : 1;
  if ([L, a, b, alpha].some((v) => v === null || Number.isNaN(v))) return null;
  return oklabToSrgb(L, a, b, alpha);
}

function parseOklchFunc(value) {
  const m = value.match(/^oklch\((.*)\)$/i);
  if (!m) return null;
  const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const L = parseUnitInterval(parts[0]);
  const C = parseFloat(parts[1]);
  const H = parseHueValue(parts[2]);
  const alpha = parts[3] != null ? parseAlphaValue(parts[3]) : 1;
  if ([L, C, H, alpha].some((v) => v === null || Number.isNaN(v))) return null;
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  return oklabToSrgb(L, a, b, alpha);
}

function parseUnitInterval(str) {
  const s = String(str).trim();
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(s)) return clamp(parseFloat(s) / 100, 0, 1);
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)) {
    const n = parseFloat(s);
    // Accept CSS-style lightness values written without a percent sign
    // when they are clearly outside the normalized 0..1 range.
    return clamp(n > 1 ? n / 100 : n, 0, 1);
  }
  return null;
}

function parseAlphaValue(str) {
  const s = String(str).trim();
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(s)) return clamp(parseFloat(s) / 100, 0, 1);
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)) return clamp(parseFloat(s), 0, 1);
  return null;
}

function parseHueValue(str) {
  const s = String(str).trim().toLowerCase();
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  if (s.endsWith('turn')) return normalizeHue(n * 360);
  if (s.endsWith('rad')) return normalizeHue(n * (180 / Math.PI));
  if (s.endsWith('grad')) return normalizeHue(n * 0.9);
  return normalizeHue(n);
}

function parsePercent(str) {
  const clean = cleanWeightArg(String(str)).trim();
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(clean)) return parseFloat(clean);
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(clean)) return parseFloat(clean);
  return null;
}

function parsePercentValue(str) {
  const v = parsePercent(str);
  if (v === null) return null;
  return clamp(v, 0, 100);
}

function parseNumber(str) {
  const m = String(str).trim().match(/^-?(?:\d+(?:\.\d+)?|\.\d+)/);
  return m ? parseFloat(m[0]) : null;
}

function resolveRelativeChannel(base, expr, isPercent) {
  expr = String(expr).trim();
  if (expr === 's' || expr === 'l') return base;
  if (/^calc\(/i.test(expr)) {
    const inner = expr.replace(/^calc\(/i, '').replace(/\)$/, '').trim();
    const add = inner.match(/^[a-z]+\s*\+\s*(-?\d+(?:\.\d+)?)/i);
    const sub = inner.match(/^[a-z]+\s*-\s*(-?\d+(?:\.\d+)?)/i);
    if (add) return clamp(base + parseFloat(add[1]), 0, isPercent ? 100 : 255);
    if (sub) return clamp(base - parseFloat(sub[1]), 0, isPercent ? 100 : 255);
  }
  const pct = parsePercent(expr);
  if (pct !== null) return clamp(pct, 0, isPercent ? 100 : 255);
  return base;
}

function mixColors(c1, c2, weightFirst) {
  const w1 = clamp(weightFirst, 0, 1);
  const w2 = 1 - w1;
  const a1 = c1.a ?? 1;
  const a2 = c2.a ?? 1;
  return {
    r: Math.round(c1.r * w1 + c2.r * w2),
    g: Math.round(c1.g * w1 + c2.g * w2),
    b: Math.round(c1.b * w1 + c2.b * w2),
    a: +(a1 * w1 + a2 * w2).toFixed(3)
  };
}

function colorToCss(c) {
  const a = c.a == null ? 1 : c.a;
  if (a >= 0.999) return `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)})`;
  return `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)} / ${+a.toFixed(3)})`;
}

function rgbToHsl(c) {
  let r = c.r / 255;
  let g = c.g / 255;
  let b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }

  return { h: Math.round(h * 360), s: +(s * 100).toFixed(2), l: +(l * 100).toFixed(2) };
}

function hslToRgb(h, s, l, a = 1) {
  h = normalizeHue(h) / 360;
  s /= 100;
  l /= 100;
  let r, g, b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a };
}

function oklabToSrgb(L, a, b, alpha = 1) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  return {
    r: Math.round(linearToSrgb(rLin) * 255),
    g: Math.round(linearToSrgb(gLin) * 255),
    b: Math.round(linearToSrgb(bLin) * 255),
    a: alpha
  };
}

function linearToSrgb(channel) {
  const v = clamp(channel, 0, 1);
  if (v <= 0.0031308) return 12.92 * v;
  return 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function normalizeHue(h) {
  let v = Number(h) || 0;
  while (v < 0) v += 360;
  while (v >= 360) v -= 360;
  return v;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

module.exports = { activate, deactivate };
