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
  },
  startLiveTranscription: () => ipcRenderer.invoke('transcription:start-live'),
  stopLiveTranscription: () => ipcRenderer.invoke('transcription:stop-live'),
  getTranscriptionState: () => ipcRenderer.invoke('transcription:get-state'),
  onTranscriptSegment: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, segment: unknown): void => {
      callback(segment as Parameters<typeof callback>[0])
    }
    ipcRenderer.on('transcription:segment', handler)
    return () => {
      ipcRenderer.removeListener('transcription:segment', handler)
    }
  },
  onTranscriptionError: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, error: unknown): void => {
      callback(error as Parameters<typeof callback>[0])
    }
    ipcRenderer.on('transcription:error', handler)
    return () => {
      ipcRenderer.removeListener('transcription:error', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
