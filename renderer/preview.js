// Renders a file preview into an element. Shared by Quick Look and the preview pane.
// window.Preview.fill(el, entry, { autoplay, helpers }) where helpers supplies
// fileUrl, fmtSize, fmtDate, badge (special folder badge) from the app.
(function () {
  const I = window.Icons;
  const api = window.fsApi;
  const esc = I.esc;

  const WEB_IMAGES = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
  const PLAYABLE_VIDEO = new Set(['mp4', 'webm', 'm4v', 'mov', 'mkv', 'ogv']);
  const RICH = new Set(['docx', 'docm', 'dotx', 'doc', 'dot', 'pptx', 'pptm', 'xlsx', 'xlsm', 'xls', 'xlt', 'xlsb', 'ods', 'zip', 'jar', 'apk', 'epub', 'nupkg', 'vsix']);
  const MARKDOWN = new Set(['md', 'markdown', 'mdx']);
  const DELIMITED = { csv: ',', tsv: '\t' };

  // ---------- markdown (escaped first, so the output is safe) ----------
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '<u>$1</u>');
  }
  function markdown(src) {
    const out = [];
    let list = null; let code = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const line of src.split(/\r?\n/)) {
      if (code !== null) {
        if (/^```/.test(line)) { out.push(`<pre class="md-code">${esc(code)}</pre>`); code = null; } else code += `${line}\n`;
        continue;
      }
      if (/^```/.test(line)) { closeList(); code = ''; continue; }
      let m;
      if ((m = /^(#{1,6})\s+(.*)/.exec(line))) { closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
      if ((m = /^\s*[-*+]\s+(?:\[( |x)\]\s+)?(.*)/i.exec(line))) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        const box = m[1] ? `<span class="md-box">${m[1].toLowerCase() === 'x' ? '☑' : '☐'}</span> ` : '';
        out.push(`<li>${box}${inline(m[2])}</li>`); continue;
      }
      if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push(`<li>${inline(m[1])}</li>`); continue;
      }
      closeList();
      if ((m = /^>\s?(.*)/.exec(line))) { out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
      if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out.push('<hr>'); continue; }
      if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (code !== null) out.push(`<pre class="md-code">${esc(code)}</pre>`);
    closeList();
    return `<div class="pv-scroll"><article class="pv-doc md">${out.join('')}</article></div>`;
  }

  // ---------- delimited text ----------
  function parseDelimited(text, sep, maxRows = 300) {
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length && rows.length < maxRows; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
      } else if (c === '"') q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if ((cell || row.length) && rows.length < maxRows) { row.push(cell); rows.push(row); }
    return rows;
  }

  function colName(i) {
    let s = ''; i += 1;
    while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  function table(rows, { tabs = [], note = '' } = {}) {
    const width = Math.min(40, Math.max(1, ...rows.map((r) => r.length)));
    const head = `<tr><th></th>${Array.from({ length: width }, (_, i) => `<th>${colName(i)}</th>`).join('')}</tr>`;
    const body = rows.map((r, i) => `<tr><th>${i + 1}</th>${Array.from({ length: width }, (_, c) => `<td>${esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('');
    const tabBar = tabs.length ? `<div class="sheet-tabs">${tabs.map((t, i) => `<span class="${i === 0 ? 'on' : ''}">${esc(t)}</span>`).join('')}</div>` : '';
    return `<div class="pv-sheet"><div class="pv-scroll"><table class="grid-table">${head}${body}</table></div>${tabBar}${note ? `<div class="pv-note">${note}</div>` : ''}</div>`;
  }

  // ---------- code / text ----------
  function textBlock(text, truncated) {
    const lines = text.split(/\r?\n/);
    const shown = lines.slice(0, 5000);
    const gutter = shown.map((_, i) => i + 1).join('\n');
    const more = truncated || lines.length > shown.length ? '<div class="pv-note">只顯示檔案開頭部分</div>' : '';
    return `<div class="pv-scroll pv-code"><pre class="gutter">${gutter}</pre><pre class="src">${esc(shown.join('\n'))}</pre></div>${more}`;
  }

  // ---------- Office / archive (parsed in Rust) ----------
  function rich(r, h) {
    if (r.type === 'doc') {
      const paras = r.paragraphs.map((p) => {
        if (!p.text.trim()) return '';
        const lvl = Math.min(p.heading, 4);
        return lvl ? `<h${lvl}>${esc(p.text)}</h${lvl}>` : `<p>${esc(p.text).replace(/\n/g, '<br>')}</p>`;
      }).join('');
      return `<div class="pv-scroll"><article class="pv-doc page">${paras || '<p class="muted">（沒有文字內容）</p>'}</article></div>${r.truncated ? '<div class="pv-note">文件很長，只顯示前段</div>' : ''}`;
    }
    if (r.type === 'slides') {
      return `<div class="pv-scroll"><div class="pv-slides">${r.slides.map((lines, i) => `
        <div class="slide"><span class="slide-no">${i + 1}</span><div class="slide-body">
          ${lines.length ? `<b>${esc(lines[0])}</b>${lines.slice(1, 8).map((l) => `<span>${esc(l)}</span>`).join('')}` : '<span class="muted">（沒有文字）</span>'}
        </div></div>`).join('')}</div></div>`;
    }
    if (r.type === 'sheet') {
      return table(r.rows, { tabs: r.sheets, note: r.truncated ? '只顯示第一個工作表的前 300 列' : '' });
    }
    if (r.type === 'archive') {
      const rows = r.entries.map((e) => `
        <div class="arc-row${e.isDir ? ' dir' : ''}">${e.isDir ? I.folder() : I.file((e.name.split('.').pop() || '').toLowerCase())}
          <span class="nm">${esc(e.name)}</span><span class="sz">${e.isDir ? '' : h.fmtSize(e.size)}</span></div>`).join('');
      const more = r.total > r.entries.length ? `，只列出前 ${r.entries.length} 個` : '';
      return `<div class="pv-scroll"><div class="pv-archive">${rows}</div></div><div class="pv-note">共 ${r.total} 個項目${more}</div>`;
    }
    return null;
  }

  function infoCard(e, h, extra = '') {
    return `<div class="ql-info">${h.icon?.(e) || (e.isDir ? I.folder(h.badge(e.path)) : I.file(e.ext))}
      <div class="pv-name">${esc(e.name)}</div>
      <div class="pv-kind">${esc(I.kindLabel(e))}${e.isDir ? '' : ` — ${h.fmtSize(e.size)}`}</div>${extra}</div>`;
  }

  async function fill(el, e, { autoplay = false, helpers: h }) {
    const token = (el._tok = (el._tok || 0) + 1);
    const alive = () => el._tok === token;
    el.innerHTML = '';
    el.dataset.kind = '';
    const set = (html, kind) => { if (alive()) { el.innerHTML = html; el.dataset.kind = kind; h.after?.(el); zoomable(el); } };
    const cat = I.category(e.ext);

    if (e.isDir) {
      const count = await api.folderCount(e.path);
      set(infoCard(e, h, `<div class="pv-kind">${count == null ? '' : `${count} 個項目`}</div>`), 'info');
      return;
    }
    const url = h.fileUrl(e.path);
    if (WEB_IMAGES.has(e.ext)) return set(`<img src="${url}" draggable="false">`, 'media');
    if (cat === 'video' && PLAYABLE_VIDEO.has(e.ext)) {
      return set(`<video src="${url}" controls ${autoplay ? 'autoplay' : 'muted'} playsinline></video>`, 'media');
    }
    if (cat === 'audio') {
      return set(`${infoCard(e, h)}<audio src="${url}" controls ${autoplay ? 'autoplay' : ''}></audio>`, 'info');
    }
    if (e.ext === 'pdf') return set(`<iframe src="${url}"></iframe>`, 'frame');

    if (RICH.has(e.ext) && api.richPreview) {
      const r = await api.richPreview(e.path).catch(() => null);
      if (!alive()) return;
      const html = r && rich(r, h);
      if (html) return set(html, 'doc');
    }

    const texty = MARKDOWN.has(e.ext) || DELIMITED[e.ext] || ['text', 'code', 'other'].includes(cat);
    if (texty && (e.size || 0) < 50e6) {
      const res = await api.readText(e.path);
      if (!alive()) return;
      if (res.text != null) {
        if (MARKDOWN.has(e.ext)) return set(markdown(res.text), 'doc');
        if (DELIMITED[e.ext]) return set(table(parseDelimited(res.text, DELIMITED[e.ext]), { note: res.truncated ? '只顯示檔案開頭部分' : '' }), 'doc');
        return set(textBlock(res.text, res.truncated), 'doc');
      }
    }

    // Windows renders thumbnails for Office, PSD, HEIC and other formats.
    // With Windows icons on, other files (apps, shortcuts...) show their icon.
    if (h.icon?.(e) && !h.canThumb(e)) return set(infoCard(e, h), 'info');
    const thumb = await api.thumb(e.path, 1024);
    if (!alive()) return;
    set(thumb ? `<img src="${thumb}" draggable="false">` : infoCard(e, h), thumb ? 'media' : 'info');
  }

  // Zoom for previews: images and videos zoom around the pointer (wheel,
  // double-click, or the bar) and pan by dragging; documents, tables and code
  // zoom with Ctrl+wheel or the bar and keep scrolling normally.
  // `el._zoom.step(+1 / -1 / 0)` serves keyboard shortcuts.
  const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
  function zoomable(el) {
    el._zoom = null;
    const media = el.querySelector(':scope > img, :scope > video');
    const doc = el.querySelector('.pv-scroll');
    if (!media && !doc) return;
    let z = 1; let x = 0; let y = 0;
    const bar = document.createElement('div');
    bar.className = 'zbar';
    bar.innerHTML = '<button data-z="-1" title="縮小 (Ctrl+-)">−</button><span>100%</span><button data-z="1" title="放大 (Ctrl+=)">+</button><button data-z="0" title="符合視窗 (Ctrl+0)">符合</button>';
    el.appendChild(bar);
    const apply = () => {
      if (media) {
        media.style.transform = z === 1 ? '' : `translate(${x}px, ${y}px) scale(${z})`;
        media.classList.toggle('zoomed', z > 1);
      } else {
        for (const c of doc.children) c.style.zoom = z === 1 ? '' : z;
      }
      bar.querySelector('span').textContent = `${Math.round(z * 100)}%`;
      bar.classList.toggle('changed', z !== 1);
    };
    // Zoom to `nz`, keeping the point (px, py) — relative to the box centre — still.
    const zoomTo = (nz, px = 0, py = 0) => {
      nz = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], nz));
      if (media) {
        x = px - (px - x) * (nz / z);
        y = py - (py - y) * (nz / z);
        if (nz <= 1) { x = 0; y = 0; }
      }
      z = nz;
      apply();
    };
    const step = (dir, px, py) => {
      if (dir === 0) { zoomTo(1); return; }
      const next = dir > 0 ? ZOOMS.find((v) => v > z + 1e-3) : [...ZOOMS].reverse().find((v) => v < z - 1e-3);
      if (next) zoomTo(next, px, py);
    };
    const rel = (ev) => {
      const r = el.getBoundingClientRect();
      return [ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2)];
    };
    el._zoom = { step };
    bar.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-z]');
      if (b) step(Number(b.dataset.z));
    });
    bar.addEventListener('mousedown', (ev) => ev.stopPropagation());
    el.addEventListener('wheel', (ev) => {
      if (!el.contains(bar)) return; // content was replaced
      if (!media && !ev.ctrlKey) return; // documents scroll normally
      ev.preventDefault();
      const [px, py] = rel(ev);
      // A mouse-wheel notch is one 25% step; touchpads send small deltas.
      const f = Math.abs(ev.deltaY) >= 50 ? (ev.deltaY < 0 ? 1.25 : 0.8) : Math.exp(-ev.deltaY * 0.01);
      zoomTo(z * f, px, py);
    }, { passive: false });
    if (!media) return;
    media.addEventListener('dblclick', (ev) => {
      const [px, py] = rel(ev);
      zoomTo(z > 1 ? 1 : 2, px, py);
    });
    media.addEventListener('mousedown', (ev) => {
      if (z <= 1 || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const sx = ev.clientX - x; const sy = ev.clientY - y;
      media.classList.add('panning');
      const move = (e) => { x = e.clientX - sx; y = e.clientY - sy; apply(); };
      const up = () => {
        media.classList.remove('panning');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  window.Preview = { fill, markdown, parseDelimited };
})();
