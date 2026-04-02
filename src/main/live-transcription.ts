import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'
import * as audioCapture from './audio-capture'
import { TranscriberClient, type FatalEvent, type HelperSegmentEvent } from './transcriber-client'
import type { TranscriptSegment, TranscriptionError, TranscriptionState } from '../shared/ipc-types'

type StreamSource = 'mic' | 'system'

type SegmentListener = (segment: TranscriptSegment) => void
type ErrorListener = (error: TranscriptionError) => void

interface PendingSegment {
  receivedAtMs: number
  segment: TranscriptSegment
}

interface TimeNormalizerState {
  firstNativeTimestamp?: number
  firstArrivalOffsetSec?: number
  lastNormalizedEndSec: number
}

const MODEL_ENV_VAR = 'CEREAL_WHISPER_MODEL_PATH'
const HOLD_BACK_MS = 300
const FLUSH_INTERVAL_MS = 100
const SYSTEM_VERSION_ERROR =
  'Real-time transcription requires macOS 14.0 or later because WhisperKit currently targets macOS 14+.'

class TimeNormalizer {
  private startedAtMs = Date.now()
  private states: Record<StreamSource, TimeNormalizerState> = {
    mic: { lastNormalizedEndSec: 0 },
    system: { lastNormalizedEndSec: 0 }
  }

  reset(): void {
    this.startedAtMs = Date.now()
    this.states = {
      mic: { lastNormalizedEndSec: 0 },
      system: { lastNormalizedEndSec: 0 }
    }
  }

  normalize(source: StreamSource, nativeTimestamp: number, sampleCount: number): number {
    const state = this.states[source]
    const arrivalOffsetSec = (Date.now() - this.startedAtMs) / 1000
    const durationSec = sampleCount / 16000

    if (state.firstArrivalOffsetSec === undefined) {
      state.firstArrivalOffsetSec = arrivalOffsetSec
    }

    let normalizedStart = state.lastNormalizedEndSec
    if (Number.isFinite(nativeTimestamp)) {
      if (state.firstNativeTimestamp === undefined) {
        state.firstNativeTimestamp = nativeTimestamp
      }

      normalizedStart =
        state.firstArrivalOffsetSec +
        Math.max(0, nativeTimestamp - state.firstNativeTimestamp)

      if (normalizedStart + 0.25 < state.lastNormalizedEndSec) {
        normalizedStart = state.lastNormalizedEndSec
      }
    }

    state.lastNormalizedEndSec = Math.max(state.lastNormalizedEndSec, normalizedStart + durationSec)
    return Number(normalizedStart.toFixed(3))
  }
}

class LiveTranscriptionService {
  private state: TranscriptionState = 'idle'
  private readonly client = new TranscriberClient()
  private readonly segmentListeners = new Set<SegmentListener>()
  private readonly errorListeners = new Set<ErrorListener>()
  private readonly normalizer = new TimeNormalizer()
  private chunkUnsubscribe: (() => void) | null = null
  private audioErrorUnsubscribe: (() => void) | null = null
  private sessionId: string | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private pendingSegments: PendingSegment[] = []
  private nextSequence = 1
  private handlingFatalError = false
  private teardownPromise: Promise<void> | null = null

  constructor() {
    this.client.onSegment((event) => {
      this.handleSegmentEvent(event)
    })
    this.client.onError((event) => {
      void this.handleClientError(event)
    })
  }

  async start(): Promise<void> {
    if (this.teardownPromise) {
      await this.teardownPromise
    }

    if (this.state === 'recording' || this.state === 'starting') {
      return
    }
    if (this.state === 'stopping') {
      throw new Error('Transcription is stopping')
    }
    if (this.state === 'error') {
      throw new Error('Transcription is recovering from a previous failure')
    }

    ensureSupportedMacOS()
    const modelPath = resolveModelPath()

    this.state = 'starting'
    this.normalizer.reset()
    this.pendingSegments = []
    this.nextSequence = 1
    this.sessionId = randomUUID()

    try {
      await this.client.loadModel(modelPath)
      await this.client.startSession(this.sessionId)

      this.audioErrorUnsubscribe = audioCapture.onError((message) => {
        this.emitError({
          code: 'audio_capture_warning',
          message,
          fatal: false
        })
      })

      this.chunkUnsubscribe = audioCapture.onAudioChunk((source, samples, timestamp) => {
        if (!this.sessionId || (this.state !== 'recording' && this.state !== 'starting')) {
          return
        }

        const normalizedStartTimeSec = this.normalizer.normalize(source, timestamp, samples.length)
        try {
          this.client.appendAudio(this.sessionId, source, normalizedStartTimeSec, samples)
        } catch (error) {
          void this.handleClientError({
            type: 'fatal',
            code: 'append_audio_failed',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })

      await audioCapture.startCapture(16000)
      this.state = 'recording'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emitError({
        code: 'transcription_start_failed',
        message,
        fatal: true
      })
      try {
        await this.beginTeardown(false)
      } finally {
        this.state = 'idle'
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.teardownPromise) {
      await this.teardownPromise
      return
    }
    if (this.state === 'idle') {
      return
    }
    if (this.state === 'stopping') {
      return
    }

    this.state = 'stopping'
    const sessionId = this.sessionId
    await this.stopCaptureOnly()

    if (sessionId) {
      try {
        await this.client.stopSession(sessionId)
      } catch (error) {
        this.emitError({
          code: 'session_stop_failed',
          message: error instanceof Error ? error.message : String(error),
          fatal: false
        })
      }
    }

    this.flushPendingSegments(true)
    this.clearFlushTimer()
    this.sessionId = null
    await this.client.shutdown()
    this.resetSessionState()
    this.state = 'idle'
  }

  getState(): TranscriptionState {
    return this.state
  }

  onSegment(listener: SegmentListener): () => void {
    this.segmentListeners.add(listener)
    return () => this.segmentListeners.delete(listener)
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  logPlatformSupportWarning(): void {
    const issue = getUnsupportedMacOSReason()
    if (issue) {
      console.error(issue)
    }
  }

  private handleSegmentEvent(event: HelperSegmentEvent): void {
    if (!this.sessionId || event.sessionId !== this.sessionId) {
      return
    }

    const segment: TranscriptSegment = {
      id: randomUUID(),
      source: event.stream,
      isMe: event.stream === 'mic',
      text: event.text,
      startTimeSec: Number(event.startTimeSec.toFixed(3)),
      endTimeSec: Number(event.endTimeSec.toFixed(3)),
      sequence: this.nextSequence++
    }

    this.pendingSegments.push({
      receivedAtMs: Date.now(),
      segment
    })

    this.schedulePendingFlush()
  }

  private async handleClientError(event: FatalEvent | { type: 'warning'; code: string; message: string }): Promise<void> {
    const error: TranscriptionError = {
      code: event.code,
      message: event.message,
      fatal: event.type === 'fatal'
    }

    this.emitError(error)

    if (event.type === 'fatal' && !this.handlingFatalError) {
      this.handlingFatalError = true
      this.state = 'error'
      try {
        await this.beginTeardown(true)
      } finally {
        this.state = 'idle'
        this.handlingFatalError = false
      }
    }
  }

  private schedulePendingFlush(): void {
    if (this.flushTimer) {
      return
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushPendingSegments(false)
      if (this.pendingSegments.length > 0) {
        this.schedulePendingFlush()
      }
    }, FLUSH_INTERVAL_MS)
  }

  private flushPendingSegments(force: boolean): void {
    if (this.pendingSegments.length === 0) {
      return
    }

    const readyCutoff = Date.now() - HOLD_BACK_MS
    this.pendingSegments.sort(comparePendingSegments)

    const remaining: PendingSegment[] = []
    for (const pending of this.pendingSegments) {
      if (!force && pending.receivedAtMs > readyCutoff) {
        remaining.push(pending)
        continue
      }

      for (const listener of this.segmentListeners) {
        listener(pending.segment)
      }
    }

    this.pendingSegments = remaining
  }

  private emitError(error: TranscriptionError): void {
    for (const listener of this.errorListeners) {
      listener(error)
    }
  }

  private async teardown(skipSessionStop: boolean): Promise<void> {
    await this.stopCaptureOnly()

    const sessionId = this.sessionId
    if (!skipSessionStop && sessionId) {
      try {
        await this.client.stopSession(sessionId)
      } catch {
        // Helper shutdown still happens below.
      }
    }

    this.flushPendingSegments(true)
    this.clearFlushTimer()
    this.sessionId = null

    try {
      await this.client.shutdown()
    } catch {
      // Process exit is handled by the client.
    }

    this.resetSessionState()
  }

  private beginTeardown(skipSessionStop: boolean): Promise<void> {
    if (this.teardownPromise) {
      return this.teardownPromise
    }

    this.teardownPromise = (async () => {
      try {
        await this.teardown(skipSessionStop)
      } finally {
        this.teardownPromise = null
      }
    })()

    return this.teardownPromise
  }

  private async stopCaptureOnly(): Promise<void> {
    this.chunkUnsubscribe?.()
    this.chunkUnsubscribe = null

    this.audioErrorUnsubscribe?.()
    this.audioErrorUnsubscribe = null

    await audioCapture.stopCapture()
  }

  private resetSessionState(): void {
    this.pendingSegments = []
    this.normalizer.reset()
    this.nextSequence = 1
    this.clearFlushTimer()
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) {
      return
    }

    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }
}

function comparePendingSegments(left: PendingSegment, right: PendingSegment): number {
  if (left.segment.startTimeSec !== right.segment.startTimeSec) {
    return left.segment.startTimeSec - right.segment.startTimeSec
  }
  if (left.segment.sequence !== right.segment.sequence) {
    return left.segment.sequence - right.segment.sequence
  }
  if (left.segment.source === right.segment.source) {
    return 0
  }
  return left.segment.source === 'mic' ? -1 : 1
}

function resolveModelPath(): string {
  const devModelPath = app.isPackaged
    ? undefined
    : join(app.getAppPath(), 'resources', 'models', 'whisper-large-v3')

  const candidates = [
    process.env[MODEL_ENV_VAR],
    'resourcesPath' in process && typeof process.resourcesPath === 'string'
      ? `${process.resourcesPath}/models/whisper-large-v3`
      : undefined,
    devModelPath
  ]

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Whisper model directory not found. Set ${MODEL_ENV_VAR} or package the model into Contents/Resources/models/whisper-large-v3.`
  )
}

function ensureSupportedMacOS(): void {
  const issue = getUnsupportedMacOSReason()
  if (issue) {
    throw new Error(issue)
  }
}

function getUnsupportedMacOSReason(): string | null {
  const electronProcess = process as typeof process & {
    getSystemVersion?: () => string
  }
  const version = electronProcess.getSystemVersion?.()
  if (!version) {
    return null
  }

  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major >= 14) {
    return null
  }

  return SYSTEM_VERSION_ERROR
}

const service = new LiveTranscriptionService()

export async function startLiveTranscription(): Promise<void> {
  return service.start()
}

export async function stopLiveTranscription(): Promise<void> {
  return service.stop()
}

export function getTranscriptionState(): TranscriptionState {
  return service.getState()
}

export function onTranscriptSegment(listener: SegmentListener): () => void {
  return service.onSegment(listener)
}

export function onTranscriptionError(listener: ErrorListener): () => void {
  return service.onError(listener)
}

export function logTranscriptionPlatformSupportWarning(): void {
  service.logPlatformSupportWarning()
}
