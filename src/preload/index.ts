import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi } from '../shared/ipc-types'

const api: IpcApi = {
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  nativePing: () => ipcRenderer.invoke('native:ping'),
  // Audio capture
  checkPermissions: () => ipcRenderer.invoke('audio:check-permissions'),
  requestPermissions: () => ipcRenderer.invoke('audio:request-permissions'),
  startCapture: (sampleRate?: number) => ipcRenderer.invoke('audio:start-capture', sampleRate),
  stopCapture: () => ipcRenderer.invoke('audio:stop-capture'),
  getCaptureState: () => ipcRenderer.invoke('audio:get-state'),
  onAudioChunk: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, chunk: unknown): void => {
      callback(chunk as Parameters<typeof callback>[0])
    }
    ipcRenderer.on('audio:chunk', handler)
    return () => {
      ipcRenderer.removeListener('audio:chunk', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
