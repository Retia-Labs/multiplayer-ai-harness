/* Quorum desktop - the code editor.
 *
 * No editor library. The whole thing is a highlighted <pre> with a transparent
 * <textarea> sitting exactly on top of it: the textarea does selection, caret,
 * undo, IME and accessibility, which browsers already do far better than a
 * hand-rolled editor would, and the <pre> underneath supplies the colour. The
 * two must share identical font metrics, padding and line-height or the caret
 * drifts from the text, which is the only real failure mode of this approach.
 *
 * This buys a genuinely useful editor in a few hundred lines with zero
 * dependencies, and it is honest about what it is not: no LSP, no multi-cursor,
 * no folding. The editor is here so you can read and correct what the agent
 * did without leaving the run - not to replace the editor you already have.
 */
(function () {
  'use strict';

  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ---------------------------------------------------------------- *
   * Highlighting
   *
   * One pass, longest-match-first, over an alternation of the things that
   * matter: comments and strings first (they swallow everything inside them),
   * then numbers, keywords and identifiers. Deliberately approximate - a
   * tokenizer accurate enough to be worth 3000 lines is not worth 3000 lines
   * here.
   * ---------------------------------------------------------------- */

  const KEYWORDS = {
    js: 'const let var function return if else for while do break continue new class extends super this typeof instanceof in of async await try catch finally throw switch case default delete void yield static get set import export from as null undefined true false',
    py: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del not and or is in None True False async await self',
    rs: 'fn let mut const struct enum impl trait pub use mod match if else for while loop return break continue self Self where as dyn ref move async await unsafe crate super true false Some None Ok Err',
    go: 'func package import var const type struct interface map chan go defer if else for range return break continue switch case default select nil true false',
    css: 'important media supports keyframes import charset font-face',
    html: ''
  };

  const LANG_BY_EXT = {
    js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', json: 'json',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
    md: 'md', markdown: 'md',
    py: 'py', rs: 'rs', go: 'go',
    java: 'js', c: 'js', h: 'js', cpp: 'js', hpp: 'js', cs: 'js', php: 'js', rb: 'py',
    sh: 'py', bash: 'py', yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml'
  };

  function langFor(filePath) {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    if (filePath.split('/').pop().toLowerCase() === 'dockerfile') return 'py';
    return LANG_BY_EXT[ext] || 'plain';
  }

  function keywordSet(lang) {
    const src = KEYWORDS[lang] || KEYWORDS.js;
    return new Set(src.split(' '));
  }

  function highlight(text, lang) {
    if (lang === 'plain') return esc(text);
    if (lang === 'md') return highlightMarkdown(text);
    if (lang === 'html') return highlightMarkup(text);

    const kw = keywordSet(lang === 'json' || lang === 'yaml' ? 'js' : lang);
    const hashComment = lang === 'py' || lang === 'yaml';

    // Order matters: whatever matches first wins, so comments and strings lead.
    const pattern = new RegExp(
      [
        hashComment ? '#[^\\n]*' : '//[^\\n]*',
        '/\\*[\\s\\S]*?\\*/',
        '"(?:[^"\\\\\\n]|\\\\.)*"',
        "'(?:[^'\\\\\\n]|\\\\.)*'",
        '`(?:[^`\\\\]|\\\\.)*`',
        '\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b',
        '[A-Za-z_$][\\w$]*',
        '[^\\s\\w]'
      ].join('|'),
      'g'
    );

    let out = '';
    let last = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const tok = m[0];
      out += esc(text.slice(last, m.index));
      last = m.index + tok.length;

      const c0 = tok[0];
      if ((hashComment && c0 === '#') || tok.startsWith('//') || tok.startsWith('/*')) {
        out += '<i class="t-com">' + esc(tok) + '</i>';
      } else if (c0 === '"' || c0 === "'" || c0 === '`') {
        out += '<i class="t-str">' + esc(tok) + '</i>';
      } else if (/^\d/.test(tok)) {
        out += '<i class="t-num">' + esc(tok) + '</i>';
      } else if (kw.has(tok)) {
        out += '<i class="t-kw">' + esc(tok) + '</i>';
      } else if (/^[A-Za-z_$]/.test(tok)) {
        // A name immediately followed by "(" is being called. Colouring that
        // differently is the single cheapest thing that makes code scannable.
        const after = text.slice(last).match(/^\s*\(/);
        out += after
          ? '<i class="t-fn">' + esc(tok) + '</i>'
          : esc(tok);
      } else {
        out += '<i class="t-pun">' + esc(tok) + '</i>';
      }
    }
    out += esc(text.slice(last));
    return out;
  }

  function highlightMarkdown(text) {
    return text
      .split('\n')
      .map((line) => {
        if (/^\s*#{1,6}\s/.test(line)) return '<i class="t-kw">' + esc(line) + '</i>';
        if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
          const m = line.match(/^(\s*(?:[-*+]|\d+\.)\s)([\s\S]*)$/);
          return '<i class="t-pun">' + esc(m[1]) + '</i>' + esc(m[2]);
        }
        if (/^\s*>/.test(line)) return '<i class="t-com">' + esc(line) + '</i>';
        if (/^\s*```/.test(line)) return '<i class="t-str">' + esc(line) + '</i>';
        return esc(line);
      })
      .join('\n');
  }

  function highlightMarkup(text) {
    let out = '';
    let last = 0;
    const re = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*|"[^"]*"|'[^']*'|\/?>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const tok = m[0];
      out += esc(text.slice(last, m.index));
      last = m.index + tok.length;
      if (tok.startsWith('<!--')) out += '<i class="t-com">' + esc(tok) + '</i>';
      else if (tok[0] === '"' || tok[0] === "'") out += '<i class="t-str">' + esc(tok) + '</i>';
      else out += '<i class="t-kw">' + esc(tok) + '</i>';
    }
    out += esc(text.slice(last));
    return out;
  }

  /* ---------------------------------------------------------------- *
   * The editor
   * ---------------------------------------------------------------- */

  function create(opts) {
    const { root, api, getThreadId, onDirty } = opts;

    const state = {
      tree: [],
      filter: '',
      open: [],        // [{path, content, saved, mtimeMs, lang, binary, tooLarge}]
      activePath: null,
      collapsed: new Set()
    };

    root.innerHTML =
      '<div class="ed-tree">' +
        '<div class="ed-tree-head">' +
          '<input id="ed-filter" class="ed-filter" type="text" placeholder="Filter files" spellcheck="false" />' +
        '</div>' +
        '<div id="ed-tree-list" class="ed-tree-list"></div>' +
      '</div>' +
      '<div class="ed-main">' +
        '<div id="ed-tabs" class="ed-tabs"></div>' +
        '<div id="ed-pane" class="ed-pane">' +
          '<div class="ed-empty">Choose a file to open it.</div>' +
        '</div>' +
        '<div id="ed-status" class="ed-status"></div>' +
      '</div>';

    const $tree = root.querySelector('#ed-tree-list');
    const $filter = root.querySelector('#ed-filter');
    const $tabs = root.querySelector('#ed-tabs');
    const $pane = root.querySelector('#ed-pane');
    const $status = root.querySelector('#ed-status');

    $filter.addEventListener('input', () => {
      state.filter = $filter.value.trim().toLowerCase();
      renderTree();
    });

    function status(text, tone) {
      $status.textContent = text || '';
      $status.className = 'ed-status' + (tone ? ' ' + tone : '');
    }

    function fileOf(p) {
      return state.open.find((f) => f.path === p) || null;
    }

    function dirty(f) {
      return f && !f.binary && !f.tooLarge && f.content !== f.saved;
    }

    function anyDirty() {
      return state.open.some(dirty);
    }

    /* ---------------- tree ---------------- */

    async function refresh() {
      const id = getThreadId();
      if (!id) return;
      try {
        state.tree = await api.files.tree(id);
      } catch (err) {
        state.tree = [];
        status(String(err.message || err), 'bad');
      }
      renderTree();
    }

    function visibleEntries() {
      if (state.filter) {
        return state.tree
          .filter((e) => !e.dir && e.path.toLowerCase().includes(state.filter))
          .slice(0, 300);
      }
      // Hide anything inside a collapsed directory.
      return state.tree.filter((e) => {
        for (const dir of state.collapsed) {
          if (e.path !== dir && e.path.startsWith(dir + '/')) return false;
        }
        return true;
      });
    }

    function renderTree() {
      const entries = visibleEntries();
      if (!entries.length) {
        $tree.innerHTML = '<div class="ed-tree-empty">' +
          (state.filter ? 'Nothing matches.' : 'No files here.') + '</div>';
        return;
      }
      const frag = document.createDocumentFragment();
      for (const e of entries) {
        const depth = state.filter ? 0 : e.path.split('/').length - 1;
        const row = document.createElement('button');
        row.className = 'ed-row' + (e.dir ? ' is-dir' : '') +
          (e.path === state.activePath ? ' is-active' : '') +
          (!e.dir && !e.text ? ' is-locked' : '');
        row.style.paddingLeft = 8 + depth * 12 + 'px';
        row.title = e.path;

        const name = state.filter ? e.path : e.path.split('/').pop();
        if (e.dir) {
          const open = !state.collapsed.has(e.path);
          row.innerHTML = '<span class="ed-caret">' + (open ? '▾' : '▸') + '</span>' +
            '<span class="ed-name">' + esc(name) + '</span>';
          row.addEventListener('click', () => {
            if (state.collapsed.has(e.path)) state.collapsed.delete(e.path);
            else state.collapsed.add(e.path);
            renderTree();
          });
        } else {
          row.innerHTML = '<span class="ed-name">' + esc(name) + '</span>' +
            (e.tracked ? '' : '<span class="ed-untracked" title="Not tracked by git">U</span>');
          row.addEventListener('click', () => open(e.path));
        }
        frag.appendChild(row);
      }
      $tree.innerHTML = '';
      $tree.appendChild(frag);
    }

    /* ---------------- opening ---------------- */

    async function open(relPath) {
      const id = getThreadId();
      if (!id) return;
      if (!fileOf(relPath)) {
        let res;
        try {
          res = await api.files.read(id, relPath);
        } catch (err) {
          status(String(err.message || err), 'bad');
          return;
        }
        state.open.push({
          path: relPath,
          content: res.content || '',
          saved: res.content || '',
          hash: res.hash || null,
          lang: langFor(relPath),
          binary: !!res.binary,
          tooLarge: !!res.tooLarge,
          size: res.size || 0
        });
      }
      state.activePath = relPath;
      // Recorded so a watcher can see where attention is.
      api.files.viewing(id, relPath).catch(() => {});
      renderTabs();
      renderPane();
      renderTree();
    }

    function close(relPath) {
      const f = fileOf(relPath);
      if (f && dirty(f) && !window.confirm('Discard unsaved changes to ' + relPath + '?')) return;
      state.open = state.open.filter((x) => x.path !== relPath);
      if (state.activePath === relPath) {
        state.activePath = state.open.length ? state.open[state.open.length - 1].path : null;
      }
      renderTabs();
      renderPane();
      renderTree();
      if (onDirty) onDirty(anyDirty());
    }

    function renderTabs() {
      if (!state.open.length) {
        $tabs.innerHTML = '';
        return;
      }
      $tabs.innerHTML = '';
      for (const f of state.open) {
        const tab = document.createElement('div');
        tab.className = 'ed-tab' + (f.path === state.activePath ? ' is-active' : '');
        tab.innerHTML =
          '<span class="ed-tab-name">' + esc(f.path.split('/').pop()) + '</span>' +
          (dirty(f) ? '<span class="ed-dot" title="Unsaved">●</span>' : '') +
          '<button class="ed-tab-x" title="Close">×</button>';
        tab.addEventListener('click', (ev) => {
          if (ev.target.classList.contains('ed-tab-x')) close(f.path);
          else open(f.path);
        });
        $tabs.appendChild(tab);
      }
    }

    /* ---------------- the editing surface ---------------- */

    function renderPane() {
      const f = fileOf(state.activePath);
      if (!f) {
        $pane.innerHTML = '<div class="ed-empty">Choose a file to open it.</div>';
        status('');
        return;
      }
      if (f.binary) {
        $pane.innerHTML = '<div class="ed-empty">This file is binary. Nothing to show.</div>';
        status(f.path + ' · binary · ' + f.size + ' bytes');
        return;
      }
      if (f.tooLarge) {
        $pane.innerHTML = '<div class="ed-empty">This file is too large to open here.</div>';
        status(f.path + ' · ' + Math.round(f.size / 1024) + ' KB');
        return;
      }

      $pane.innerHTML =
        '<div class="ed-code">' +
          '<div class="ed-gutter" id="ed-gutter"></div>' +
          '<div class="ed-scroll" id="ed-scroll">' +
            '<pre class="ed-hl" id="ed-hl" aria-hidden="true"></pre>' +
            '<textarea class="ed-ta" id="ed-ta" spellcheck="false" autocomplete="off" ' +
              'autocapitalize="off" autocorrect="off" wrap="off"></textarea>' +
          '</div>' +
        '</div>';

      const ta = $pane.querySelector('#ed-ta');
      const hl = $pane.querySelector('#ed-hl');
      const gutter = $pane.querySelector('#ed-gutter');
      const scroll = $pane.querySelector('#ed-scroll');

      ta.value = f.content;
      paint();

      ta.addEventListener('input', () => {
        f.content = ta.value;
        paint();
        renderTabs();
        if (onDirty) onDirty(anyDirty());
      });

      // Scrolling the textarea has to move the highlight layer and the gutter
      // with it, or the colour slides off the code.
      ta.addEventListener('scroll', () => {
        hl.style.transform = 'translate(' + -ta.scrollLeft + 'px,' + -ta.scrollTop + 'px)';
        gutter.scrollTop = ta.scrollTop;
      });

      ta.addEventListener('keydown', (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
          ev.preventDefault();
          save();
          return;
        }
        // Tab inserts a tab instead of leaving the editor. Shift+Tab is left to
        // the browser so keyboard users can still get out.
        if (ev.key === 'Tab' && !ev.shiftKey) {
          ev.preventDefault();
          const s = ta.selectionStart;
          const e = ta.selectionEnd;
          ta.setRangeText('  ', s, e, 'end');
          f.content = ta.value;
          paint();
          renderTabs();
          if (onDirty) onDirty(anyDirty());
        }
      });

      function paint() {
        // The trailing newline keeps the last line paintable and stops the
        // highlight layer collapsing shorter than the textarea.
        hl.innerHTML = highlight(ta.value + '\n', f.lang);
        const lines = ta.value.split('\n').length;
        let g = '';
        for (let i = 1; i <= lines; i++) g += i + '\n';
        gutter.textContent = g;
        status(
          f.path + ' · ' + lines + ' lines · ' + f.lang +
          (dirty(f) ? ' · unsaved' : ''),
          dirty(f) ? 'warn' : ''
        );
      }

      scroll.dataset.ready = '1';
    }

    /* ---------------- saving ---------------- */

    async function save() {
      const id = getThreadId();
      const f = fileOf(state.activePath);
      if (!id || !f || !dirty(f)) return;
      let res;
      try {
        res = await api.files.write(id, f.path, f.content, f.hash);
      } catch (err) {
        status(String(err.message || err), 'bad');
        return;
      }
      if (!res.ok && res.stale) {
        // The agent edited this file while it was open. Overwriting silently
        // would delete its work, so the person is told and chooses.
        const take = window.confirm(
          f.path + ' changed on disk while you were editing it, probably by the agent.\n\n' +
          'OK to overwrite it with your version, or Cancel to reload theirs and lose yours.'
        );
        if (take) {
          const forced = await api.files.write(id, f.path, f.content, null);
          f.hash = forced.hash;
          f.saved = f.content;
          status('Saved over their version · ' + f.path, 'warn');
        } else {
          const fresh = await api.files.read(id, f.path);
          f.content = fresh.content;
          f.saved = fresh.content;
          f.hash = fresh.hash;
          renderPane();
          status('Reloaded from disk · ' + f.path);
        }
        renderTabs();
        if (onDirty) onDirty(anyDirty());
        return;
      }
      f.saved = f.content;
      f.hash = res.hash;
      status('Saved · ' + f.path, 'ok');
      renderTabs();
      refresh();
      if (onDirty) onDirty(anyDirty());
    }

    return {
      refresh,
      open,
      save,
      hasUnsaved: anyDirty,
      focusFilter: () => $filter.focus()
    };
  }

  window.QuorumEditor = { create, highlight, langFor };
})();
