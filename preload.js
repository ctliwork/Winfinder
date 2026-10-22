const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('fsApi', {
  places: () => ipcRenderer.invoke('fs:places'),
  list: (dir) => ipcRenderer.invoke('fs:list', dir),
  diskFree: (dir) => ipcRenderer.invoke('fs:diskFree', dir),
  diskSpace: (dir) => ipcRenderer.invoke('fs:diskSpace', dir),
  recentFiles: () => ipcRenderer.invoke('fs:recent'),
  folderCount: (dir) => ipcRenderer.invoke('fs:folderCount', dir),
  thumb: (file, size) => ipcRenderer.invoke('fs:thumb', file, size),
  nativeIcon: (file) => ipcRenderer.invoke('fs:nativeIcon', file),
  open: (file) => ipcRenderer.invoke('fs:open', file),
  reveal: (file) => ipcRenderer.invoke('fs:reveal', file),
  trash: (files) => ipcRenderer.invoke('fs:trash', files),
  rename: (file, name) => ipcRenderer.invoke('fs:rename', file, name),
  mkdir: (dir) => ipcRenderer.invoke('fs:mkdir', dir),
  transfer: (op, files, dest) => ipcRenderer.invoke('fs:transfer', op, files, dest),
  readText: (file) => ipcRenderer.invoke('fs:readText', file),
  search: (root, q, hidden) => ipcRenderer.invoke('fs:search', root, q, hidden),
  watch: (dirs) => ipcRenderer.send('fs:watch', dirs),
  onChanged: (cb) => ipcRenderer.on('fs:changed', (_e, dir) => cb(dir)),
  startDrag: (files) => ipcRenderer.send('drag:start', files),
  pathForFile: (file) => webUtils.getPathForFile(file),
});

contextBridge.exposeInMainWorld('winApi', {
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
  close: () => ipcRenderer.send('win:close'),
  onState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s)),
});

contextBridge.exposeInMainWorld('pathApi', {
  sep: path.sep,
  join: (...p) => path.join(...p),
  dirname: (p) => path.dirname(p),
  basename: (p) => path.basename(p),
  extname: (p) => path.extname(p),
  root: (p) => path.parse(p).root,
  fileUrl: (p) => pathToFileURL(p).href,
});
