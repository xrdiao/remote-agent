// Rules shared by the PWA, relay and injected native-page helpers.
globalThis.RemoteAgentRules = (() => {
  const textExtensions = ['txt', 'md', 'csv', 'json', 'log', 'sh', 'yaml', 'yml', 'xml', 'html', 'css', 'py', 'js', 'ts', 'jsx', 'tsx', 'cpp', 'c', 'h', 'rs', 'go', 'toml', 'ini'];
  const documentExtensions = ['pdf', 'doc', 'docx', 'xlsx', 'pptx'];
  const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  const previewImageTypes = { ...imageTypes, '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
  const uploadAccept = [...documentExtensions, ...textExtensions].map(ext => '.' + ext).join(',');
  const uploadDocument = name => [...documentExtensions, ...textExtensions].some(ext => String(name).toLowerCase().endsWith('.' + ext));
  const desktopAction = (message, app, mode) => {
    if (['overviewManage', 'saveComputerFile', 'computerFileAction', 'newTerminal', 'closeTerminal'].includes(message.t)) return true;
    if (app === 'fusion') return false;
    return message.t === 'send' ? message.submit !== false && mode !== 'terminal'
      : message.t === 'queue' ? message.action !== 'read'
      : ['stop', 'pickMenu', 'question', 'codexRequest', 'click', 'subagent', 'saveFile', 'sessionManage', 'sessionBatch', 'codexRename', 'codexArchive'].includes(message.t);
  };
  const parseAgentRef = value => {
    const text = String(value || ''), first = text.indexOf(':');
    if (first < 0) return { kind: '', windowId: '', id: text };
    const kind = text.slice(0, first), rest = text.slice(first + 1);
    const start = /^\/?[a-z]:[\\/]/i.test(rest) ? rest.indexOf(':') + 1 : 0;
    const separator = rest.indexOf(':', start);
    if (!['project', 'thread', 'new', 'project-new'].includes(kind)) return { kind, windowId: '', id: rest };
    if (kind === 'new' && /^[a-z]:[\\/]/i.test(rest)) return { kind, windowId: '', id: decodeURIComponent(rest) };
    if (separator < 0) {
      const value = decodeURIComponent(rest);
      return kind === 'new' && /^(?:\/|\\|[a-z]:[\\/]|file:\/\/)/i.test(value)
        ? { kind, windowId: '', id: value } : { kind, windowId: value, id: '' };
    }
    return { kind, windowId: decodeURIComponent(rest.slice(0, separator)), id: decodeURIComponent(rest.slice(separator + 1)) };
  };
  const parseSessionRef = (app, value) => {
    let id = String(value || '');
    if (id.startsWith('project:') || app === 'codex' && id.startsWith('thread:')) id = parseAgentRef(id).id;
    return app === 'devin' ? id.replace(/^tab:/, '') : id;
  };
  const isLocalFileReference = href => /^(?:file:\/\/|\/|~\/|[A-Za-z]:[\\/]|\.{1,2}\/)/.test(href)
    || (!/^[A-Za-z][\w+.-]*:/.test(href) && /\.[A-Za-z0-9]{1,10}(?:#L\d+(?:-L?\d+)?)?$/.test(href));
  const codeBlockHtml = (source, body) => `<div class="codebox"><textarea class="src" hidden readonly>${source}</textarea><pre>${body}</pre></div>`;
  const notificationTarget = value => ({ computer: value.computer || '', win: value.win || '', windowId: value.windowId || '', threadId: value.threadId || '' });
  const notificationKey = (value, compact = false) => {
    const parts = Object.values(notificationTarget(value));
    return (compact ? parts.filter(Boolean) : parts).join('|');
  };
  const titleParts = title => {
    const host = /\[SSH: ([^\]]+)\]/.exec(title)?.[1] || null;
    return { title: title.replace(/\s*\[SSH: [^\]]+\]\s*$/, ''), host };
  };
  const cleanWindowTitle = title => String(title || '').replace(/\s*\[(?:Administrator|Administer)\]/gi, '').trim();
  const parseWindowTitle = title => {
    title = cleanWindowTitle(title);
    const windowsTitle = /\s+-\s+(?:Cursor|Devin|Visual Studio Code)$/.test(title);
    title = title.replace(/\s+-\s+(?:Cursor|Devin|Visual Studio Code)$/, '');
    const parsed = titleParts(title);
    const parts = parsed.title.split(windowsTitle ? / — | - / : ' — ').map(s => s.replace(/^●\s*/, '').trim());
    return { name: parts.pop() || title, file: parts.join(' — '), host: parsed.host };
  };
  const normalizeReceiptText = value => (value || '').replace(/\s+/g, ' ').trim();
  const withoutAttachmentLabels = value => (value || '').replace(/(?:^|\n)\[(?:图片|附件) \d+\](?:\n\[(?:图片|附件) \d+\])*$/, '');
  return { desktopAction, parseAgentRef, parseSessionRef, isLocalFileReference, codeBlockHtml, notificationTarget, notificationKey,
    titleParts, cleanWindowTitle, parseWindowTitle, normalizeReceiptText, withoutAttachmentLabels, textExtensions, documentExtensions, imageTypes, previewImageTypes, uploadAccept, uploadDocument };
})();
