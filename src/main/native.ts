import { app } from 'electron'
import { join } from 'path'

interface HelloAddon {
  getSystemInfo: () => { macosVersion: string; screenCaptureKitAvailable: boolean }
}

let helloAddon: HelloAddon | null = null
let loadError: string | null = null

export function getAddonPath(addonName: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'native', `${addonName}.node`)
  }
  // Dev mode: cmake-js output directory
  return join(__dirname, '..', '..', 'src', 'native', 'build', 'Release', `${addonName}.node`)
}

export function getHelperPath(helperName: string): string {
  const executableName = process.platform === 'win32' ? `${helperName}.exe` : helperName
  if (app.isPackaged) {
    return join(process.resourcesPath, 'native', executableName)
  }
  return join(__dirname, '..', '..', 'src', 'native', 'build', 'Release', executableName)
}

export function loadHelloAddon(): HelloAddon | null {
  if (helloAddon) return helloAddon
  if (loadError) return null

  try {
    const addonPath = getAddonPath('hello')
    helloAddon = require(addonPath) as HelloAddon
    return helloAddon
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    console.error('Failed to load native addon:', loadError)
    return null
  }
}

export function getLoadError(): string | null {
  return loadError
}
