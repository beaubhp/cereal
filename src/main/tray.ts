import { app, BrowserWindow, Tray, nativeImage, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let tray: Tray | null = null
let popoverWindow: BrowserWindow | null = null
let isQuitting = false

function getTrayIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'icons', 'tray-bowl.png')
  }

  return join(__dirname, '../../resources/icons/tray-bowl.png')
}

function loadTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(getTrayIconPath())

  if (icon.isEmpty()) {
    console.error(`Failed to load tray icon from ${getTrayIconPath()}`)
    return nativeImage.createEmpty()
  }

  icon.setTemplateImage(true)
  return icon
}

function createPopoverWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 400,
    height: 600,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Hide instead of close
  win.on('close', (e) => {
    if (isQuitting) {
      return
    }

    e.preventDefault()
    win.hide()
  })

  // Hide when focus is lost
  win.on('blur', () => {
    if (!isQuitting) {
      win.hide()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function positionWindowBelowTray(win: BrowserWindow, trayBounds: Electron.Rectangle): void {
  const winBounds = win.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y
  })

  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2)
  const y = trayBounds.y + trayBounds.height + 4

  // Clamp to screen bounds
  const clampedX = Math.max(
    display.workArea.x,
    Math.min(x, display.workArea.x + display.workArea.width - winBounds.width)
  )

  win.setPosition(clampedX, y)
}

export function createTray(): void {
  app.on('before-quit', () => {
    isQuitting = true
  })

  tray = new Tray(loadTrayIcon())
  tray.setToolTip('Cereal')

  popoverWindow = createPopoverWindow()

  tray.on('click', () => {
    if (!popoverWindow) return

    if (popoverWindow.isVisible()) {
      popoverWindow.hide()
    } else {
      const bounds = tray!.getBounds()
      positionWindowBelowTray(popoverWindow, bounds)
      popoverWindow.show()
    }
  })
}

export function getPopoverWindow(): BrowserWindow | null {
  return popoverWindow
}
