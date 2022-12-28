// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

import fs from 'fs';
import path from 'path';

import { marked } from 'marked';

marked.setOptions({ headerIds: true });


import * as common from './common.mjs';
import * as typeParser from './type-parser.mjs';

const docPath = new URL('../../doc/', import.meta.url);

const gtocPath = new URL('./api/index.md', docPath);
const gtocMD = fs.readFileSync(gtocPath, 'utf8')
  .replace(/\(([^#?]+?)\.md\)/ig, (_, filename) => `(${filename}.html)`)
  .replace(/^<!--.*?-->/gms, '');
const gtocHTML = marked.parse(gtocMD, marked.defaults).replace(
  /<a href="(.*?)"/g,
  (all, href) => `<a href="${href}" class="nav-${href.replace('.html', '')
                                      .replace(/\W+/g, '-')}"`
);

const templatePath = new URL('./template.html', docPath);
const template = fs.readFileSync(templatePath, 'utf8');

import { replaceLinks } from './markdown.mjs';
const linksMapperFile = new URL('links-mapper.json', import.meta.url);
const linksMapper = JSON.parse(fs.readFileSync(linksMapperFile, 'utf8'));

function processContent(content) {
  content = content.toString();
  // Increment header tag levels to avoid multiple h1 tags in a doc.
  // This means we can't already have an <h6>.
  if (content.includes('<h6>')) {
    throw new Error('Cannot increment a level 6 header');
  }
  // `++level` to convert the string to a number and increment it.
  content = content.replace(/(?<=<\/?h)[1-5](?=[^<>]*>)/g, (level) => ++level);
  // Wrap h3 tags in section tags unless they are immediately preceded by a
  // section tag. The latter happens when GFM footnotes are generated. We don't
  // want to add another section tag to the footnotes section at the end of the
  // document because that will result in an empty section element. While not an
  // HTML error, it's enough for validator.w3.org to print a warning.
  let firstTime = true;
  return content
    .replace(/(?<!<section [^>]+>)<h3/g, (heading) => {
      if (firstTime) {
        firstTime = false;
        return '<section>' + heading;
      }
      return '</section><section>' + heading;
    }) + (firstTime ? '' : '</section>');
}

export async function toHTML({ input, filename, nodeVersion, versions, apilinks }) {
  filename = path.basename(filename, '.md');

  input = input.replace(/\\\[\]/g, '[]');

  const lexed = marked.lexer(input);

  const firstHeading = lexed.find(({ type }) => type === 'heading');
  const section = firstHeading ? firstHeading.text : 'Index';

  preprocessText(lexed);
  preprocessElements(lexed, { filename });

  marked.walkTokens(lexed, replaceLinks({ filename, linksMapper }));
  const tocContent = buildToc(lexed, { filename, apilinks });
  const content = marked.parser(lexed, marked.defaults);

  const id = filename.replace(/\W+/g, '-');

  let HTML = template.replace('__ID__', id)
                     .replace(/__FILENAME__/g, filename)
                     .replace('__SECTION__', section)
                     .replace(/__VERSION__/g, nodeVersion)
                     .replace(/__TOC__/g, tocContent.toc)
                     .replace(/__TOC_PICKER__/g, tocPicker(id, tocContent))
                     .replace(/__GTOC_PICKER__/g, gtocPicker(id))
                     .replace(/__GTOC__/g, gtocHTML.replace(
                       `class="nav-${id}"`, `class="nav-${id} active"`))
                     .replace('__EDIT_ON_GITHUB__', editOnGitHub(filename))
                     .replace('__CONTENT__', processContent(content));

  const docCreated = input.match(
    /<!--\s*introduced_in\s*=\s*v([0-9]+)\.([0-9]+)\.[0-9]+\s*-->/);
  if (docCreated) {
    HTML = HTML.replace('__ALTDOCS__', altDocs(filename, docCreated, versions));
  } else {
    console.error(`Failed to add alternative version links to ${filename}`);
    HTML = HTML.replace('__ALTDOCS__', '');
  }

  return HTML;
}

// Handle general body-text replacements.
// For example, link man page references to the actual page.
export function preprocessText(lexed) {
  marked.walkTokens(lexed, (token) => {
    if (!token.text) return;
    if (['code', 'codespan'].includes(token.type) == false) {
      token.text = replaceInText(token.text);
    }
  });
}

// Replace placeholders in text tokens.
function replaceInText(text = '') {
  if (text === '') return text;
  return linkJsTypeDocs(linkManPages(text));
}

// Syscalls which appear in the docs, but which only exist in BSD / macOS.
const BSD_ONLY_SYSCALLS = new Set(['lchmod']);
const MAN_PAGE = /(^|\s)([a-z.]+)\((\d)([a-z]?)\)/gm;

// Handle references to man pages, eg "open(2)" or "lchmod(2)".
// Returns modified text, with such refs replaced with HTML links, for example
// '<a href="http://man7.org/linux/man-pages/man2/open.2.html">open(2)</a>'.
function linkManPages(text) {
  return text.replace(
    MAN_PAGE, (match, beginning, name, number, optionalCharacter) => {
      // Name consists of lowercase letters,
      // number is a single digit with an optional lowercase letter.
      const displayAs = `<code>${name}(${number}${optionalCharacter})</code>`;

      if (BSD_ONLY_SYSCALLS.has(name)) {
        return `${beginning}<a href="https://www.freebsd.org/cgi/man.cgi?query=${name}&sektion=${number}">${displayAs}</a>`;
      }

      return `${beginning}<a href="http://man7.org/linux/man-pages/man${number}/${name}.${number}${optionalCharacter}.html">${displayAs}</a>`;
    });
}

const TYPE_SIGNATURE = /[_$]?\{[a-zA-Z\[\]^}]+\}/g;
function linkJsTypeDocs(text) {
  if (text.startsWith('<pre>')) return text;
  const parts = text.split('`');

  // Handle types, for example the source Markdown might say
  // "This argument should be a {number} or {string}".
  try {
    for (let i = 0; i < parts.length; i += 2) {
      const typeMatches = parts[i].match(TYPE_SIGNATURE);
      if (typeMatches) {
        typeMatches.forEach((typeMatch) => {
          if (/^[_$]/.test(typeMatch)) return;
          parts[i] = parts[i].replace(typeMatch, typeParser.toLink(typeMatch));
        });
      }
    }
  } catch(ex) {
    console.warn(ex, "in", text);
  }
  return parts.join('`');
}

// Preprocess stability blockquotes and YAML blocks.
export function preprocessElements(lexed, { filename }) {
  const STABILITY_RE = /(.*:)\s*(\d)([\s\S]*)/;
  let state = null;
  let headingIndex = -1;
  let heading = null;

  marked.walkTokens(lexed, (token) => {
    if (token.type === 'heading') {
      headingIndex = 0;
      heading = token;
    } else {
      headingIndex++;
    }
    if (token.type === 'html' && common.isYAMLBlock(token.text)) {
      token.text = parseYAML(token.text);
    }
    if (token.type === 'blockquote_start') {
      state = 'MAYBE_STABILITY_BQ';
    }
    if (token.type === 'blockquote_end' && state === 'MAYBE_STABILITY_BQ') {
      state = null;
    }
    if (token.type === 'paragraph' && state === 'MAYBE_STABILITY_BQ') {
      if (token.text.includes('Stability:')) {
        const [, prefix, number, explication] =
          token.text.match(STABILITY_RE);

        // Stability indices are never more than 3 nodes away from their
        // heading.
        const isStabilityIndex = headingIndex <= 3;

        if (heading && isStabilityIndex) {
          heading.stability = number;
          heading = null;
        }

        // Do not link to the section we are already in.
        const noLinking = filename.includes('documentation') &&
          heading !== null && heading.text === 'Stability index';

        token.text = `<div class="api_stability api_stability_${number}">` +
          (noLinking ? '' :
            '<a href="documentation.html#stability-index">') +
          `${prefix} ${number}${noLinking ? '' : '</a>'}${explication}</div>`
          .replace(/\n/g, ' ');
      } else if (state === 'MAYBE_STABILITY_BQ') {
        state = null;
      }
    }
  });
}

function parseYAML(text) {
  const meta = common.extractAndParseYAML(text);
  let result = '<div class="api_metadata">\n';

  const added = { description: '' };
  const deprecated = { description: '' };
  const removed = { description: '' };

  if (meta.added) {
    added.version = meta.added.join(', ');
    added.description = `<span>Added in: ${added.version}</span>`;
  }

  if (meta.deprecated) {
    deprecated.version = meta.deprecated.join(', ');
    deprecated.description =
        `<span>Deprecated since: ${deprecated.version}</span>`;
  }

  if (meta.removed) {
    removed.version = meta.removed.join(', ');
    removed.description = `<span>Removed in: ${removed.version}</span>`;
  }

  if (meta.changes.length > 0) {
    if (added.description) meta.changes.push(added);
    if (deprecated.description) meta.changes.push(deprecated);
    if (removed.description) meta.changes.push(removed);

    meta.changes.sort((a, b) => versionSort(a.version, b.version));

    result += '<details class="changelog"><summary>History</summary>\n' +
            '<table>\n<tr><th>Version</th><th>Changes</th></tr>\n';

    meta.changes.forEach((change) => {
      const description = marked.parse(change.description);
      const version = common.arrify(change.version).join(', ');

      result += `<tr><td>${version}</td>\n` +
                  `<td>${description}</td></tr>\n`;
    });

    result += '</table>\n</details>\n';
  } else {
    result += `${added.description}${deprecated.description}${removed.description}\n`;
  }

  if (meta.napiVersion) {
    result += `<span>N-API version: ${meta.napiVersion.join(', ')}</span>\n`;
  }

  result += '</div>';
  return result;
}

function minVersion(a) {
  return common.arrify(a).reduce((min, e) => {
    return !min || versionSort(min, e) < 0 ? e : min;
  });
}

const numberRe = /^\d*/;
function versionSort(a, b) {
  a = minVersion(a).trim();
  b = minVersion(b).trim();
  let i = 0; // Common prefix length.
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  a = a.substr(i);
  b = b.substr(i);
  return +b.match(numberRe)[0] - +a.match(numberRe)[0];
}

const DEPRECATION_HEADING_PATTERN = /^DEP\d+:/;
export function buildToc(lexed, { filename, apilinks }) {
  const idCounters = Object.create(null);
  const legacyIdCounters = Object.create(null);
  let toc = '';
  let depth = 0;

  lexed.forEach((node) => {
    if (node.type !== 'heading') return;

    if (node.depth - depth > 1) {
        throw new Error(
          `Inappropriate heading level:\n${JSON.stringify(node)}`
        );
    }

    depth = node.depth;
    const realFilename = path.basename(filename, '.md');
    const headingText = node.text.trim();
    const id = getId(headingText, idCounters);
    // Use previous ID generator to create alias
    const legacyId = getLegacyId(`${realFilename}_${headingText}`, legacyIdCounters);

    const isDeprecationHeading =
      DEPRECATION_HEADING_PATTERN.test(headingText);
    if (isDeprecationHeading) {
      node.raw = getId(headingText.substring(0, headingText.indexOf(':')), idCounters);
    }

    const hasStability = node.stability !== undefined;
    toc += ' '.repeat((depth - 1) * 2) +
      (hasStability ? `* <span class="stability_${node.stability}">` : '* ') +
      `<a href="#${isDeprecationHeading ? node.raw : id}">${headingText}</a>${hasStability ? '</span>' : ''}\n`;

    let anchor =
      `<span><a class="mark" href="#${id}" id="${id}">#</a></span>`;

    // Add alias anchor to preserve old links
    anchor += `<a aria-hidden="true" class="legacy" id="${legacyId}"></a>`;

    if (realFilename === 'errors' && headingText.startsWith('ERR_')) {
      anchor +=
        `<span><a class="mark" href="#${headingText}" id="${headingText}">#</a></span>`;
    }

    const api = headingText.replace(/^.*:\s+/, '').replace(/\(.*/, '');
    if (apilinks[api]) {
      anchor = `<a class="srclink" href=${apilinks[api]}>[src]</a>${anchor}`;
    }
    node.tokens.push({ type: 'text', text: anchor });
  });

  let tocPicker;
  if (toc !== '') {
    const inner = marked.parse(toc, marked.defaults);
    toc = `<details id="toc" open><summary>Table of contents</summary>${inner}</details>`;
    tocPicker = `<div class="toc">${inner}</div>`;
  } else {
    toc = tocPicker = '<!-- TOC -->';
  }
  return { toc, tocPicker };
}

// ID generator that mirrors Github's heading anchor parser
const punctuation = /[^\w\- ]/g;
function getId(text, idCounters) {
  text = text.toLowerCase()
             .replace(punctuation, '')
             .replace(/ /g, '-');
  if (idCounters[text] !== undefined) {
    return `${text}_${++idCounters[text]}`;
  }
  idCounters[text] = 0;
  return text;
}

// This ID generator is purely to generate aliases
// so we can preserve old doc links
const notAlphaNumerics = /[^a-z0-9]+/g;
const edgeUnderscores = /^_+|_+$/g;
const notAlphaStart = /^[^a-z]/;
function getLegacyId(text, idCounters) {
  text = text.toLowerCase()
             .replace(notAlphaNumerics, '_')
             .replace(edgeUnderscores, '')
             .replace(notAlphaStart, '_$&');
  if (idCounters[text] !== undefined) {
    return `${text}_${++idCounters[text]}`;
  }
  idCounters[text] = 0;
  return text;
}

function altDocs(filename, docCreated, versions) {
  const [, docCreatedMajor, docCreatedMinor] = docCreated.map(Number);
  const host = 'https://nodejs.org';

  const getHref = (versionNum) =>
    `${host}/docs/latest-v${versionNum}/api/${filename}.html`;

  const wrapInListItem = (version) =>
    `<li><a href="${getHref(version.num)}">${version.num}${version.lts ? ' <b>LTS</b>' : ''}</a></li>`;

  function isDocInVersion(version) {
    const [versionMajor, versionMinor] = version.num.split('.').map(Number);
    if (docCreatedMajor > versionMajor) return false;
    if (docCreatedMajor < versionMajor) return true;
    if (Number.isNaN(versionMinor)) return true;
    return docCreatedMinor <= versionMinor;
  }

  const list = versions.filter(isDocInVersion).map(wrapInListItem).join('\n');

  return list ? `
    <li class="picker-header">
      <a href="#">
        <span class="collapsed-arrow">&#x25ba;</span><span class="expanded-arrow">&#x25bc;</span>
        Other versions
      </a>
      <div class="picker"><ol id="alt-docs">${list}</ol></div>
    </li>
  ` : '';
}

function editOnGitHub(filename) {
  return `<li class="edit_on_github"><a href="https://github.com/nodejs/node/edit/master/doc/api/${filename}.md">Edit on GitHub</a></li>`;
}

function gtocPicker(id) {
  if (id === 'index') {
    return '';
  }

  // Highlight the current module and add a link to the index
  const gtoc = gtocHTML.replace(
    `class="nav-${id}"`, `class="nav-${id} active"`
  ).replace('</ul>', `
      <li>
        <a href="index.html">Index</a>
      </li>
    </ul>
  `);

  return `
    <li class="picker-header">
      <a href="#">
        <span class="collapsed-arrow">&#x25ba;</span><span class="expanded-arrow">&#x25bc;</span>
        Index
      </a>

      <div class="picker">${gtoc}</div>
    </li>
  `;
}

function tocPicker(id, content) {
  if (id === 'index') {
    return '';
  }

  return `
    <li class="picker-header">
      <a href="#">
        <span class="collapsed-arrow">&#x25ba;</span><span class="expanded-arrow">&#x25bc;</span>
        Table of contents
      </a>

      <div class="picker">${content.tocPicker}</div>
    </li>
  `;
}
