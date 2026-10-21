// SVG icon set in a macOS-inspired style. Gradients live in one shared <defs>.
(function () {
  const defs = `
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <defs>
      <linearGradient id="g-folder-back" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#5fb1f5"/><stop offset="1" stop-color="#2f8ae6"/>
      </linearGradient>
      <linearGradient id="g-folder-front" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8fd0ff"/><stop offset=".55" stop-color="#5cb5fb"/><stop offset="1" stop-color="#3d9cf3"/>
      </linearGradient>
      <linearGradient id="g-page" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eceef2"/>
      </linearGradient>
      <linearGradient id="g-page-dark" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4a4c52"/><stop offset="1" stop-color="#36383d"/>
      </linearGradient>
      <linearGradient id="g-fold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d5d8de"/>
      </linearGradient>
      <linearGradient id="g-drive" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e9ebef"/><stop offset="1" stop-color="#b9bec7"/>
      </linearGradient>
    </defs>
  </svg>`;
  document.body.insertAdjacentHTML('afterbegin', defs);

  const CATS = {
    image: { exts: 'jpg jpeg png gif bmp webp heic heif tif tiff svg ico avif raw cr2 nef arw dng psd', color: '#34c759', label: '影像' },
    video: { exts: 'mp4 mov mkv avi wmv webm m4v flv mpg mpeg 3gp', color: '#af52de', label: '影片' },
    audio: { exts: 'mp3 wav flac aac m4a ogg wma aiff opus', color: '#ff2d55', label: '音訊' },
    pdf: { exts: 'pdf', color: '#ff3b30', label: 'PDF 文件' },
    doc: { exts: 'doc docx rtf odt pages', color: '#2b6de8', label: 'Word 文件' },
    sheet: { exts: 'xls xlsx csv ods numbers tsv', color: '#1f9d55', label: '試算表' },
    slide: { exts: 'ppt pptx odp key', color: '#ff7a1a', label: '簡報' },
    archive: { exts: 'zip rar 7z tar gz bz2 xz tgz iso dmg cab', color: '#8e8e93', label: '封存檔' },
    code: { exts: 'js ts jsx tsx mjs cjs json py rb go rs java kt c h cpp hpp cs php swift sh ps1 bat cmd html htm css scss vue xml yml yaml toml sql lua dart r', color: '#5856d6', label: '原始碼' },
    text: { exts: 'txt md log ini cfg conf nfo srt env', color: '#64748b', label: '純文字' },
    app: { exts: 'exe msi appx msix lnk url', color: '#0a84ff', label: '應用程式' },
    font: { exts: 'ttf otf woff woff2', color: '#a2845e', label: '字體' },
  };
  const extToCat = {};
  for (const [cat, def] of Object.entries(CATS)) def.exts.split(' ').forEach((e) => { extToCat[e] = cat; });

  const GLYPHS = {
    image: '<path d="M15 33l7-8 5 5 4-4 7 7z" fill="#34c759"/><circle cx="31" cy="21" r="3" fill="#ffcc00"/>',
    video: '<rect x="14" y="18" width="24" height="17" rx="3" fill="#af52de"/><path d="M23 22.5v8l6.5-4z" fill="#fff"/>',
    audio: '<path d="M23 34V20l12-3v14" stroke="#ff2d55" stroke-width="2.4" fill="none" stroke-linejoin="round"/><circle cx="20.5" cy="34" r="3.2" fill="#ff2d55"/><circle cx="32.5" cy="31" r="3.2" fill="#ff2d55"/>',
    pdf: '<path d="M17 20h18M17 25h18M17 30h12" stroke="#c7cbd3" stroke-width="2" stroke-linecap="round"/>',
    doc: '<path d="M17 19h18M17 24h18M17 29h18M17 34h11" stroke="#9fb7ee" stroke-width="2" stroke-linecap="round"/>',
    sheet: '<rect x="15" y="18" width="22" height="17" rx="1.5" fill="none" stroke="#7cc79a" stroke-width="1.8"/><path d="M15 23.7h22M15 29.3h22M22.3 18v17M29.7 18v17" stroke="#7cc79a" stroke-width="1.4"/>',
    slide: '<rect x="15" y="18" width="22" height="15" rx="2" fill="#ffb380"/><path d="M26 22.5v6.2a3.1 3.1 0 1 0 3.1-3.1z" fill="#fff"/>',
    archive: '<path d="M26 14v4m0 2v4m0 2v4" stroke="#8e8e93" stroke-width="3"/><rect x="23" y="30" width="6" height="6" rx="1.5" fill="#8e8e93"/>',
    code: '<path d="M22 21l-6 5.5 6 5.5M30 21l6 5.5-6 5.5" stroke="#5856d6" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    text: '<path d="M17 20h18M17 25h18M17 30h14" stroke="#c7cbd3" stroke-width="2" stroke-linecap="round"/>',
    app: '<rect x="16" y="17" width="20" height="20" rx="5" fill="#0a84ff"/><path d="M21 31l5-9 5 9M22.8 28h6.4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>',
    font: '<path d="M18 34l8-17 8 17M21 28h10" stroke="#a2845e" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    other: '',
  };

  function category(ext) { return extToCat[ext] || 'other'; }

  function kindLabel(entry) {
    if (entry.isDir) return '資料夾';
    const cat = category(entry.ext);
    if (cat === 'image' || cat === 'video' || cat === 'audio') return `${(entry.ext || '').toUpperCase()} ${CATS[cat].label}`;
    if (cat !== 'other') return CATS[cat].label;
    return entry.ext ? `${entry.ext.toUpperCase()} 檔案` : '文件';
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Small glyphs embossed on special folders (desktop, downloads…).
  const FOLDER_BADGES = {
    desktop: '<rect x="23" y="27" width="18" height="12" rx="1.6"/><path d="M28 43h8"/>',
    download: '<path d="M32 26v13M26.5 34l5.5 5.5 5.5-5.5"/>',
    doc: '<path d="M26 26h9l4 4v11H26z"/><path d="M29 33h7M29 37h7"/>',
    photo: '<rect x="23" y="27" width="18" height="13" rx="2"/><path d="M25 38l5-5 4 3 3-2 3 4"/>',
    music: '<path d="M30 39V28l9-2v10"/><circle cx="28" cy="39" r="2.2"/><circle cx="37" cy="36" r="2.2"/>',
    video: '<rect x="23" y="28" width="18" height="12" rx="2"/><path d="M30 31v6l4.5-3z"/>',
    home: '<path d="M24 34l8-7 8 7M26.5 32v8h11v-8"/>',
  };

  function folder(badge) {
    const b = FOLDER_BADGES[badge]
      ? `<g fill="none" stroke="#1f6fcf" stroke-opacity=".55" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${FOLDER_BADGES[badge]}</g>`
      : '';
    return `<svg class="ico folder" viewBox="0 0 64 54">
      <path d="M4 9a4 4 0 0 1 4-4h14.5a3 3 0 0 1 2.1.9L29 10h27a4 4 0 0 1 4 4v32a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="url(#g-folder-back)"/>
      <path d="M4 18.5a4 4 0 0 1 4-4h48a4 4 0 0 1 4 4V46a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="url(#g-folder-front)"/>
      <path d="M6 16.6h52" stroke="#ffffff" stroke-opacity=".55" stroke-width="1"/>
      ${b}
    </svg>`;
  }

  function file(ext) {
    const cat = category(ext);
    const color = CATS[cat]?.color || '#8e8e93';
    const label = (ext || '').slice(0, 4).toUpperCase();
    const badge = label
      ? `<rect x="9" y="43" width="34" height="11" rx="3" fill="${color}"/><text x="26" y="51.2" text-anchor="middle" font-size="7.6" font-weight="700" fill="#fff" font-family="Segoe UI, sans-serif" letter-spacing=".4">${esc(label)}</text>`
      : '';
    return `<svg class="ico file" viewBox="0 0 52 64">
      <path d="M9 2.5h24.5L47 16v41.5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-51a4 4 0 0 1 4-4z" class="page" fill="url(#g-page)" stroke="#000" stroke-opacity=".12"/>
      <path d="M33.5 2.5V12a4 4 0 0 0 4 4H47" fill="url(#g-fold)" stroke="#000" stroke-opacity=".12"/>
      ${GLYPHS[cat] || ''}
      ${badge}
    </svg>`;
  }

  function drive() {
    return `<svg class="ico drive" viewBox="0 0 64 54">
      <rect x="5" y="14" width="54" height="28" rx="6" fill="url(#g-drive)" stroke="#000" stroke-opacity=".15"/>
      <path d="M8 34h48" stroke="#fff" stroke-opacity=".6"/>
      <circle cx="51" cy="28" r="2" fill="#34c759"/>
    </svg>`;
  }

  const SIDEBAR = {
    home: '<path d="M3.5 9.5L10 4l6.5 5.5M5.5 8v7.5h9V8"/>',
    desktop: '<rect x="3" y="4" width="14" height="9.5" rx="1.5"/><path d="M7.5 16.5h5M10 13.5v3"/>',
    doc: '<path d="M5.5 2.8h6l3.5 3.5v10.9H5.5z"/><path d="M11.5 2.8v3.5H15"/>',
    download: '<circle cx="10" cy="10" r="7"/><path d="M10 6.2v7M7 10.5l3 3 3-3"/>',
    photo: '<rect x="3" y="4.5" width="14" height="11" rx="2"/><circle cx="7.3" cy="8.3" r="1.3"/><path d="M3.5 14l4-3.5 3 2.5 2.5-2 3.5 3"/>',
    music: '<path d="M7.5 15V5.5l9-2V13"/><circle cx="5.5" cy="15" r="2"/><circle cx="14.5" cy="13" r="2"/>',
    video: '<rect x="2.8" y="5" width="10.5" height="10" rx="2"/><path d="M13.3 8.5l4-2.3v7.6l-4-2.3"/>',
    drive: '<rect x="2.8" y="6" width="14.4" height="8" rx="2"/><circle cx="14" cy="10" r=".9" class="fill"/>',
    folder: '<path d="M2.8 6.2c0-1 .8-1.7 1.7-1.7h3.2l1.6 1.6h6.2c1 0 1.7.8 1.7 1.7v6.4c0 1-.8 1.7-1.7 1.7H4.5c-1 0-1.7-.8-1.7-1.7z"/>',
    recent: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.3l2.8 1.7"/>',
    tag: '<circle cx="10" cy="10" r="4.6" class="fill"/>',
  };
  function sidebar(name) {
    return `<svg class="sico" viewBox="0 0 20 20">${SIDEBAR[name] || SIDEBAR.folder}</svg>`;
  }

  window.Icons = { folder, file, drive, sidebar, category, kindLabel, esc, CATS };
})();
