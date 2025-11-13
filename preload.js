// preload.js
const { contextBridge } = require('electron');

// Whatever is in process.env.BACKEND_BASE will be copied to window.cfg.API_BASE
contextBridge.exposeInMainWorld('cfg', {
  API_BASE: process.env.BACKEND_BASE || ''
});
