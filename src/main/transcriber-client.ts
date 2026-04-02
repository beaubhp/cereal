import { existsSync } from 'fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { getHelperPath } from './native'

type StreamSource = 'mic' | 'system'

interface InitializeCommand {
  type: 'initialize'
  modelPath: string
  sampleRate: 16000
  segmentMode: 'final-only'
}

interface StartSessionCommand {
  type: 'start_session'
  sessionId: string
  streams: StreamSource[]
}

interface AppendAudioCommand {
  type: 'append_audio'
  sessionId: string
  stream: StreamSource
  chunkStartTimeSec: number
  sampleRate: 16000
  samplesBase64: string
}

interface StopSessionCommand {
  type: 'stop_session'
  sessionId: string
  flush: true
}

interface ShutdownCommand {
  type: 'shutdown'
}

type HelperCommand =
  | InitializeCommand
  | StartSessionCommand
  | AppendAudioCommand
  | StopSessionCommand
  | ShutdownCommand

interface InitializedEvent {
  type: 'initialized'
  model: string
}

interface SessionStartedEvent {
  type: 'session_started'
  sessionId: string
}

export interface HelperSegmentEvent {
  type: 'segment'
  sessionId: string
  stream: StreamSource
  sequence: number
  text: string
  startTimeSec: number
  endTimeSec: number
}

interface SessionStoppedEvent {
  type: 'session_stopped'
  sessionId: string
}

interface WarningEvent {
  type: 'warning'
  code: string
  message: string
  stream?: StreamSource
}

export interface FatalEvent {
  type: 'fatal'
  code: string
  message: string
}

type HelperEvent =
  | InitializedEvent
  | SessionStartedEvent
  | HelperSegmentEvent
  | SessionStoppedEvent
  | WarningEvent
  | FatalEvent

type Waiter = {
  predicate: (event: HelperEvent) => boolean
  resolve: (event: HelperEvent) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

type SegmentListener = (event: HelperSegmentEvent) => void
type ErrorListener = (event: FatalEvent | WarningEvent) => void

const EVENT_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 5_000

export class TranscriberClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private waiters = new Set<Waiter>()
  private segmentListeners = new Set<SegmentListener>()
  private errorListeners = new Set<ErrorListener>()
  private initializedModelPath: string | null = null
  private expectedExit = false
  private shutdownPromise: Promise<void> | null = null

  async loadModel(modelPath: string): Promise<void> {
    if (this.initializedModelPath === modelPath && this.child) {
      return
    }

    if (this.child && this.initializedModelPath !== modelPath) {
      await this.shutdown()
    }

    this.ensureSpawned()
    this.writeCommand({
      type: 'initialize',
      modelPath,
      sampleRate: 16000,
      segmentMode: 'final-only'
    })

    await this.waitForEvent(
      (event): event is InitializedEvent => event.type === 'initialized',
      EVENT_TIMEOUT_MS,
      'Timed out waiting for transcriber helper initialization'
    )
    this.initializedModelPath = modelPath
  }

  async startSession(sessionId: string): Promise<void> {
    this.ensureSpawned()
    this.writeCommand({
      type: 'start_session',
      sessionId,
      streams: ['mic', 'system']
    })

    await this.waitForEvent(
      (event): event is SessionStartedEvent =>
        event.type === 'session_started' && event.sessionId === sessionId,
      EVENT_TIMEOUT_MS,
      `Timed out waiting for transcription session ${sessionId} to start`
    )
  }

  appendAudio(
    sessionId: string,
    stream: StreamSource,
    chunkStartTimeSec: number,
    samples: Float32Array
  ): void {
    this.ensureSpawned()

    const view = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
    this.writeCommand({
      type: 'append_audio',
      sessionId,
      stream,
      chunkStartTimeSec,
      sampleRate: 16000,
      samplesBase64: view.toString('base64')
    })
  }

  async stopSession(sessionId: string): Promise<void> {
    if (!this.child) {
      return
    }

    this.writeCommand({
      type: 'stop_session',
      sessionId,
      flush: true
    })

    await this.waitForEvent(
      (event): event is SessionStoppedEvent =>
        event.type === 'session_stopped' && event.sessionId === sessionId,
      EVENT_TIMEOUT_MS,
      `Timed out waiting for transcription session ${sessionId} to stop`
    )
  }

  async shutdown(): Promise<void> {
    if (!this.child) {
      return
    }
    if (this.shutdownPromise) {
      return this.shutdownPromise
    }

    const child = this.child
    this.expectedExit = true

    this.shutdownPromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, SHUTDOWN_TIMEOUT_MS)

      child.once('exit', () => {
        clearTimeout(timer)
        this.finishShutdown()
        resolve()
      })

      try {
        this.writeCommand({ type: 'shutdown' })
        child.stdin.end()
      } catch {
        child.kill('SIGKILL')
      }
    })

    await this.shutdownPromise
  }

  onSegment(listener: SegmentListener): () => void {
    this.segmentListeners.add(listener)
    return () => this.segmentListeners.delete(listener)
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  private ensureSpawned(): void {
    if (this.child) {
      return
    }

    const helperPath = getHelperPath('transcriber_helper')
    if (!existsSync(helperPath)) {
      throw new Error(`Transcriber helper not found at ${helperPath}. Run npm run build:native after installing full Xcode.`)
    }

    const child = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    this.stdoutBuffer = ''
    this.expectedExit = false
    this.shutdownPromise = null

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.handleStdout(chunk)
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim()
      if (message) {
        console.error(`[transcriber_helper] ${message}`)
      }
    })

    child.on('error', (error) => {
      this.handleFatal({
        type: 'fatal',
        code: 'helper_spawn_failed',
        message: error.message
      })
    })

    child.on('exit', (code, signal) => {
      const exitedUnexpectedly = !this.expectedExit
      const message = signal
        ? `Transcriber helper exited with signal ${signal}`
        : `Transcriber helper exited with code ${code ?? 'unknown'}`

      this.child = null
      this.initializedModelPath = null

      if (exitedUnexpectedly) {
        this.handleFatal({
          type: 'fatal',
          code: 'helper_exited',
          message
        })
      } else {
        this.rejectWaiters(new Error('Transcriber helper exited before all waiters resolved'))
      }
    })
  }

  private writeCommand(command: HelperCommand): void {
    if (!this.child) {
      throw new Error('Transcriber helper is not running')
    }

    this.child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)

      if (!line) {
        continue
      }

      let event: HelperEvent
      try {
        event = JSON.parse(line) as HelperEvent
      } catch (error) {
        this.handleFatal({
          type: 'fatal',
          code: 'invalid_helper_output',
          message: error instanceof Error ? error.message : String(error)
        })
        continue
      }

      if (event.type === 'segment') {
        for (const listener of this.segmentListeners) {
          listener(event)
        }
      } else if (event.type === 'warning') {
        for (const listener of this.errorListeners) {
          listener(event)
        }
      } else if (event.type === 'fatal') {
        this.handleFatal(event)
      }

      this.resolveWaiters(event)
    }
  }

  private resolveWaiters(event: HelperEvent): void {
    for (const waiter of Array.from(this.waiters)) {
      if (!waiter.predicate(event)) {
        continue
      }

      clearTimeout(waiter.timeout)
      this.waiters.delete(waiter)
      waiter.resolve(event)
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of Array.from(this.waiters)) {
      clearTimeout(waiter.timeout)
      this.waiters.delete(waiter)
      waiter.reject(error)
    }
  }

  private waitForEvent<T extends HelperEvent>(
    predicate: (event: HelperEvent) => event is T,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(timeoutMessage))
      }, timeoutMs)

      const waiter: Waiter = {
        predicate,
        resolve: (event) => resolve(event as T),
        reject,
        timeout
      }

      this.waiters.add(waiter)
    })
  }

  private handleFatal(event: FatalEvent): void {
    for (const listener of this.errorListeners) {
      listener(event)
    }
    this.rejectWaiters(new Error(event.message))
  }

  private finishShutdown(): void {
    this.child = null
    this.initializedModelPath = null
    this.expectedExit = false
    this.shutdownPromise = null
    this.rejectWaiters(new Error('Transcriber helper shut down'))
  }
}
