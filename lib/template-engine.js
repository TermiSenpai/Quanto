// ============================================================
// PackPrice · QWeb-style template engine (dependency-free)
// ============================================================
// A tiny template engine for the PDF quote templates. It supports
// exactly three constructs, all using mustache delimiters:
//
//   {{ dotted.path }}          → value lookup, ALWAYS HTML-escaped
//                                (missing → '' ; never `undefined`).
//   {{#each items}} … {{/each}}→ iterate an array. Inside the block:
//                                {{this}} / {{this.x}} / bare {{x}}
//                                resolve against the current item, and
//                                {{@index}} is the 0-based position.
//                                Dotted paths still reach the outer
//                                context (the item shadows only its
//                                own keys). An empty / missing array
//                                renders nothing.
//   {{#if path}} … {{else}} … {{/if}} → truthy test on a path.
//
// There is NO raw/unescaped form. Everything substituted is escaped:
// the values are DATA, the template provides the only markup. This is
// the XSS guarantee — a malicious client name can never inject HTML
// into a rendered quote.
//
// Pure: deterministic, no I/O, no globals. On a malformed template
// (unbalanced block) it throws a clear Spanish error so the UI can
// show it. On success it leaves no leftover mustaches.
//
// User-facing error strings stay in Spanish (CLAUDE.md §2).
// ============================================================

'use strict';

// Matches any mustache tag. Group 1 is the raw inner text (trimmed by
// the caller). We deliberately accept `{{ ... }}` only (no triple form).
const TAG_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Tokenizes the template into a flat list of { type, ... } tokens:
//   { type: 'text', value }
//   { type: 'var', path }
//   { type: 'each', path } / { type: 'endeach' }
//   { type: 'if', path } / { type: 'else' } / { type: 'endif' }
function tokenize(templateStr) {
  const tokens = [];
  let lastIndex = 0;
  let match;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(templateStr)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: templateStr.slice(lastIndex, match.index) });
    }
    const inner = match[1].trim();
    if (inner.startsWith('#each ')) {
      tokens.push({ type: 'each', path: inner.slice(6).trim() });
    } else if (inner === '/each') {
      tokens.push({ type: 'endeach' });
    } else if (inner.startsWith('#if ')) {
      tokens.push({ type: 'if', path: inner.slice(4).trim() });
    } else if (inner === 'else') {
      tokens.push({ type: 'else' });
    } else if (inner === '/if') {
      tokens.push({ type: 'endif' });
    } else {
      tokens.push({ type: 'var', path: inner });
    }
    lastIndex = TAG_RE.lastIndex;
  }
  if (lastIndex < templateStr.length) {
    tokens.push({ type: 'text', value: templateStr.slice(lastIndex) });
  }
  return tokens;
}

// Parses the flat token list into a tree of nodes. Throws a clear
// Spanish error on an unbalanced block.
//   text:  { type:'text', value }
//   var:   { type:'var', path }
//   each:  { type:'each', path, body:[nodes] }
//   if:    { type:'if', path, body:[nodes], elseBody:[nodes]|null }
function parse(tokens) {
  let i = 0;

  function parseNodes(stopTypes) {
    const nodes = [];
    while (i < tokens.length) {
      const tok = tokens[i];
      if (stopTypes.includes(tok.type)) return nodes;

      if (tok.type === 'text' || tok.type === 'var') {
        nodes.push(tok);
        i += 1;
      } else if (tok.type === 'each') {
        i += 1; // consume #each
        const body = parseNodes(['endeach']);
        if (i >= tokens.length || tokens[i].type !== 'endeach') {
          throw new Error(`Plantilla mal formada: falta {{/each}} para {{#each ${tok.path}}}.`);
        }
        i += 1; // consume /each
        nodes.push({ type: 'each', path: tok.path, body });
      } else if (tok.type === 'if') {
        i += 1; // consume #if
        const body = parseNodes(['else', 'endif']);
        let elseBody = null;
        if (i < tokens.length && tokens[i].type === 'else') {
          i += 1; // consume else
          elseBody = parseNodes(['endif']);
        }
        if (i >= tokens.length || tokens[i].type !== 'endif') {
          throw new Error(`Plantilla mal formada: falta {{/if}} para {{#if ${tok.path}}}.`);
        }
        i += 1; // consume /if
        nodes.push({ type: 'if', path: tok.path, body, elseBody });
      } else if (tok.type === 'endeach') {
        throw new Error('Plantilla mal formada: {{/each}} sin {{#each}} de apertura.');
      } else if (tok.type === 'endif') {
        throw new Error('Plantilla mal formada: {{/if}} sin {{#if}} de apertura.');
      } else if (tok.type === 'else') {
        throw new Error('Plantilla mal formada: {{else}} fuera de un bloque {{#if}}.');
      } else {
        i += 1;
      }
    }
    return nodes;
  }

  const tree = parseNodes([]);
  return tree;
}

// A render scope: the current item (inside #each), its index, and the
// root context. Lookup resolves `this`/`this.x`, bare keys against the
// current item first, then dotted paths against the root.
function resolve(path, scope) {
  if (path === '@index') {
    return scope.index;
  }
  if (path === 'this') {
    return scope.item;
  }
  if (path.startsWith('this.')) {
    return getPath(scope.item, path.slice(5));
  }
  // A bare (non-dotted) key resolves against the current item first
  // when inside an each over objects, then falls back to the root.
  if (!path.includes('.') && isObject(scope.item)) {
    if (Object.prototype.hasOwnProperty.call(scope.item, path)) {
      return scope.item[path];
    }
  }
  return getPath(scope.root, path);
}

function getPath(obj, path) {
  if (obj == null) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function isObject(v) {
  return v !== null && typeof v === 'object';
}

function isTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function renderNodes(nodes, scope) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
    } else if (node.type === 'var') {
      const value = resolve(node.path, scope);
      out += (value === undefined || value === null) ? '' : escapeHtml(value);
    } else if (node.type === 'each') {
      const arr = resolve(node.path, scope);
      if (Array.isArray(arr)) {
        arr.forEach((item, index) => {
          out += renderNodes(node.body, { root: scope.root, item, index });
        });
      }
    } else if (node.type === 'if') {
      const value = resolve(node.path, scope);
      if (isTruthy(value)) {
        out += renderNodes(node.body, scope);
      } else if (node.elseBody) {
        out += renderNodes(node.elseBody, scope);
      }
    }
  }
  return out;
}

/**
 * Renders a template string against a context object.
 *
 * @param {string} templateStr
 * @param {object} [ctx]
 * @returns {string} rendered HTML (all values HTML-escaped)
 * @throws {Error} (Spanish message) on a malformed template
 */
function render(templateStr, ctx = {}) {
  if (typeof templateStr !== 'string') {
    throw new Error('La plantilla debe ser una cadena de texto.');
  }
  const tokens = tokenize(templateStr);
  const tree = parse(tokens);
  return renderNodes(tree, { root: ctx, item: undefined, index: 0 });
}

module.exports = { render };
