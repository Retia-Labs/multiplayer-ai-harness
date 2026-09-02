// Minimal dependency-free Markdown renderer (safe: escapes HTML first).
(function () {
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  }

  function render(src) {
    const lines = esc(src || '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith('```')) {
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
        i++; // closing fence
        out.push('<pre><code>' + buf.join('\n') + '</code></pre>');
        continue;
      }

      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>');
        i++;
        continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ol>' + items.join('') + '</ol>');
        continue;
      }

      if (/^\s*&gt;\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
          buf.push(inline(lines[i].replace(/^\s*&gt;\s?/, '')));
          i++;
        }
        out.push('<blockquote><p>' + buf.join('<br>') + '</p></blockquote>');
        continue;
      }

      if (line.trim() === '') { i++; continue; }

      const buf = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*&gt;)/.test(lines[i])) {
        buf.push(inline(lines[i]));
        i++;
      }
      out.push('<p>' + buf.join('<br>') + '</p>');
    }
    return out.join('');
  }

  window.renderMarkdown = render;
})();
