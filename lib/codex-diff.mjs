// Shared by app-server transcripts and the injected desktop reader.
export function codexFileDiff(changes, context = 3) {
  const diff = [];
  let add = 0, del = 0, complete = true;
  for (const change of changes) {
    const type = change.kind?.type || change.type;
    const raw = typeof change.change === 'string' ? change.change
      : change.unified_diff ?? change.unifiedDiff ?? change.diff;
    const content = change.content ?? raw;
    let lines;
    if ((type === 'add' || type === 'delete') && typeof content === 'string' && !/^(?:diff --git |--- |\+\+\+ |@@)/m.test(content)) {
      const text = content.replace(/\r\n/g, '\n');
      lines = (text === '' ? [] : text.replace(/\n$/, '').split('\n')).map(line => [type === 'add' ? '+' : '-', line]);
    } else if (typeof raw === 'string') {
      lines = raw.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map(line =>
        /^(?:diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |--- |\+\+\+ |@@|\\ No newline)/.test(line)
          ? ['…', line] : /^[+-]/.test(line) ? [line[0], line.slice(1)] : [' ', line.replace(/^ /, '')]);
      // An unmarked after-image is not a diff; it cannot establish changed lines.
      if (!lines.some(([kind]) => kind === '+' || kind === '-' || kind === '…')) lines = null;
    }
    diff.push(['…', change.path]);
    if (!lines) { complete = false; diff.push(['…', '未获取该文件差异']); continue; }
    add += lines.filter(([kind]) => kind === '+').length;
    del += lines.filter(([kind]) => kind === '-').length;
    const keep = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i][0] === '…') keep.add(i);
      if (lines[i][0] === '+' || lines[i][0] === '-')
        for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
    }
    let gap = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!keep.has(i)) { gap++; continue; }
      if (gap) { diff.push(['…', `… ${gap} 行未改动`]); gap = 0; }
      diff.push(lines[i]);
    }
    if (gap) diff.push(['…', `… ${gap} 行未改动`]);
    if (!lines.length) diff.push(['…', '空文件']);
  }
  return { diff, add: complete ? add : null, del: complete ? del : null };
}
