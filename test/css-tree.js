'use strict';

// A stylesheet as a tree, for the tests that hold web/*.css to its rules —
// enough CSS to walk this repo's files, and no more. Comments are dropped,
// quoted strings and parentheses (url(…), calc(…), :is(…)) are opaque, and
// every block becomes a node:
//
//   { prelude, decls: [ 'name: value', … ], children: [ node, … ] }
//
// `prelude` is the selector or at-rule text before the brace; a statement
// with no block (`@layer a, b;`) is a node with `statement: true`. Not a
// test file itself — node --test only runs *.test.js — so the tests that
// need it require it.

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// The end of a quoted string or a parenthesised run starting at i.
function skip(s, i) {
  const c = s[i];
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (c === '(') {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '"' || s[j] === "'") { j = skip(s, j) - 1; continue; }
      if (s[j] === '(') depth++;
      else if (s[j] === ')' && --depth === 0) return j + 1;
    }
    return j;
  }
  return i + 1;
}

function parseBlock(s) {
  const decls = [];
  const children = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '(') { i = skip(s, i); continue; }
    if (c === ';') {
      const text = s.slice(start, i).trim();
      if (text.startsWith('@')) children.push({ prelude: text, statement: true, decls: [], children: [] });
      else if (text) decls.push(text);
      start = ++i;
      continue;
    }
    if (c === '{') {
      const prelude = s.slice(start, i).trim().replace(/\s+/g, ' ');
      let depth = 1;
      let j = i + 1;
      while (j < s.length && depth) {
        if (s[j] === '"' || s[j] === "'" || s[j] === '(') { j = skip(s, j); continue; }
        if (s[j] === '{') depth++;
        else if (s[j] === '}') depth--;
        j++;
      }
      children.push({ prelude, ...parseBlock(s.slice(i + 1, j - 1)) });
      start = i = j;
      continue;
    }
    i++;
  }
  const tail = s.slice(start).trim();
  if (tail) decls.push(tail);
  return { decls, children };
}

const parse = (css) => parseBlock(stripComments(css));

// Every style rule in the tree, with the selector it applies to once nesting
// is resolved — `&` replaced by the parent's selector, conditional at-rules
// (@media, @layer) passed through, @keyframes left out because a keyframe's
// selectors are percentages, not elements.
function* rules(node, parent = null) {
  for (const child of node.children) {
    if (child.statement) continue;
    if (child.prelude.startsWith('@keyframes')) continue;
    if (child.prelude.startsWith('@')) { yield* rules(child, parent); continue; }
    const selector = parent === null ? child.prelude
      : child.prelude.split(',').map((one) => {
        const s = one.trim();
        return s.includes('&') ? s.replace(/&/g, parent) : `${parent} ${s}`;
      }).join(', ');
    yield { selector, own: child.prelude, parent, decls: child.decls, children: child.children };
    yield* rules(child, selector);
  }
}

module.exports = { parse, rules, stripComments };
