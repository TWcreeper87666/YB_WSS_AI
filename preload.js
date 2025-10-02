const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  controlWSS: (action, settings) => ipcRenderer.send("control-wss", { action, settings }),
  onStatusUpdate: (callback) => ipcRenderer.on("status-update", (event, status) => callback(status)),
  log: (callback) => ipcRenderer.on("log", (event, message) => callback(message)),
  getSettings: () => ipcRenderer.invoke("get-settings"),
});
