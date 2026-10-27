/* Codex replies whose native Markdown block is not mounted still carry the full source. */
const codexMarkdown = window.markdownit({ html: false, breaks: true });
const markdownFile = href => /^(?:file:\/\/|\/|~\/|[A-Za-z]:[\\/]|\.{1,2}\/)/.test(href)
  || (!/^[A-Za-z][\w+.-]*:/.test(href) && /\.[A-Za-z0-9]{1,10}(?:#L\d+(?:-L?\d+)?)?$/.test(href));
const markdownFilePath = href => href.startsWith('file://') ? decodeURIComponent(new URL(href).pathname) + new URL(href).hash : href;
const markdownLinkValid = codexMarkdown.validateLink.bind(codexMarkdown);
codexMarkdown.validateLink = href => href.startsWith('file://') || markdownLinkValid(href);
const markdownLinkOpen = codexMarkdown.renderer.rules.link_open || ((tokens, n, options, env, self) => self.renderToken(tokens, n, options));
codexMarkdown.renderer.rules.link_open = (tokens, n, options, env, self) => {
  const href = tokens[n].attrGet('href') || '';
  (env.fileLinks ||= []).push(markdownFile(href));
  return env.fileLinks.at(-1) ? `<code data-file="${esc(markdownFilePath(href))}">` : markdownLinkOpen(tokens, n, options, env, self);
};
codexMarkdown.renderer.rules.link_close = (tokens, n, options, env, self) => env.fileLinks.pop() ? '</code>' : self.renderToken(tokens, n, options);
const markdownCode = (tokens, n) => {
  const text = tokens[n].content.replace(/\n$/, '');
  return `<div class="codebox"><textarea class="src" hidden readonly>${esc(text)}</textarea><pre>${esc(text)}</pre></div>\n`;
};
codexMarkdown.renderer.rules.fence = markdownCode;
codexMarkdown.renderer.rules.code_block = markdownCode;
const markdownImage = codexMarkdown.renderer.rules.image;
codexMarkdown.renderer.rules.image = (tokens, n, options, env, self) => {
  const href = tokens[n].attrGet('src') || '';
  return markdownFile(href) ? `<code data-file="${esc(markdownFilePath(href))}">${esc(tokens[n].content || href)}</code>` : markdownImage(tokens, n, options, env, self);
};
codexMarkdown.inline.ruler.before('escape', 'remote_math', (state, silent) => {
  if (!['$', '\\'].includes(state.src[state.pos])) return false;
  const pattern = new RegExp(TEX_RE.source, 'y');
  pattern.lastIndex = state.pos;
  const match = pattern.exec(state.src);
  if (!match) return false;
  if (!silent) {
    const token = state.push('remote_math', '', 0);
    token.content = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim();
    token.block = match[1] != null || match[2] != null;
  }
  state.pos += match[0].length;
  return true;
});
codexMarkdown.renderer.rules.remote_math = (tokens, n) => {
  const token = tokens[n], tag = token.block ? 'div' : 'span';
  return `<${tag} class="math" data-tex="${esc(token.content)}">${esc(token.content)}</${tag}>`;
};
function codexReplyHtml(item) {
  const plain = esc(item.t || '').replace(/\n/g, '<br>');
  return item.h && item.h !== plain ? item.h : codexMarkdown.render(item.t || '');
}
