import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi } from '../shared/ipc-types'

const api: IpcApi = {
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  nativePing: () => ipcRenderer.invoke('native:ping')
}

contextBridge.exposeInMainWorld('api', api)
