import { useEffect, useState } from 'react'
import type { AppStatus, NativePingResult } from '../../shared/ipc-types'

function App() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [nativeInfo, setNativeInfo] = useState<NativePingResult | null>(null)

  useEffect(() => {
    window.api.getStatus().then(setStatus)
    window.api.nativePing().then(setNativeInfo)
  }, [])

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold">Cereal</h1>
      <p className="text-sm text-muted-foreground">On-device meeting notes</p>

      <div className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Status</span>
          <span>{status?.state ?? '...'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">macOS</span>
          <span>{nativeInfo?.macosVersion ?? '...'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">ScreenCaptureKit</span>
          <span>
            {nativeInfo === null
              ? '...'
              : nativeInfo.error
                ? nativeInfo.error
                : nativeInfo.screenCaptureKitAvailable
                  ? 'Available'
                  : 'Unavailable'}
          </span>
        </div>
      </div>
    </div>
  )
}

export default App
