import Foundation
import WhisperKit

actor WhisperPipeline {
    private struct StreamState {
        var bufferStartTimeSec: Double = 0
        var samples: [Float] = []
        var lastInferenceSampleCount: Int = 0
        var lastActivitySampleCount: Int = 0
        var lastInferenceAt: Date = .distantPast
        var lastAppendAt: Date = .distantPast
        var lastEmittedEndSec: Double = 0
        var lastEmittedText: String = ""
        var sequence: Int = 1
        var lastInferenceProducedOutput = false
        var isTranscribing = false
        var idleFlushGeneration: Int = 0
        var lastChunkPeak: Float = 0
    }

    private let sampleRate = 16000
    private let eagerInferenceSeconds = 0.8
    private let idleInferenceSeconds = 1.5
    private let trimContextSeconds = 5.0
    private let activityRmsThreshold: Float = 0.003
    private let activityPeakThreshold: Float = 0.015

    private var whisperKit: WhisperKit?
    private var sessionId: String?
    private var streams: [StreamSource: StreamState] = [:]
    private var stopping = false
    private var sessionGeneration = 0
    private var pendingSources: [StreamSource] = []
    private var pendingSourceSet: Set<StreamSource> = []
    private var activeSource: StreamSource?
    private var drainTask: Task<Void, Never>?
    private var drainTaskGeneration: Int?

    func initialize(modelPath: String, sampleRate: Int, segmentMode: String) async throws {
        guard sampleRate == self.sampleRate else {
            throw HelperError.invalidSampleRate(sampleRate)
        }
        guard segmentMode == "final-only" else {
            throw HelperError.invalidSegmentMode(segmentMode)
        }
        guard FileManager.default.fileExists(atPath: modelPath) else {
            throw HelperError.missingModel(modelPath)
        }

        let config = WhisperKitConfig(
            model: "large-v3",
            modelFolder: modelPath,
            verbose: false,
            logLevel: .none,
            prewarm: false,
            load: true,
            download: false
        )
        whisperKit = try await WhisperKit(config)
        EventWriter.write(InitializedEvent(model: modelPath))
    }

    func startSession(sessionId: String, streams requestedStreams: [StreamSource]) throws {
        guard whisperKit != nil else {
            throw HelperError.whisperUnavailable
        }

        sessionGeneration += 1
        cancelDrainLoop()
        pendingSources.removeAll()
        pendingSourceSet.removeAll()
        activeSource = nil

        self.sessionId = sessionId
        stopping = false
        streams = Dictionary(uniqueKeysWithValues: requestedStreams.map { ($0, StreamState()) })
        EventWriter.write(SessionStartedEvent(sessionId: sessionId))
    }

    func appendAudio(_ command: AppendAudioCommand) async throws {
        try validate(sessionId: command.sessionId)
        guard command.sampleRate == sampleRate else {
            throw HelperError.invalidSampleRate(command.sampleRate)
        }
        guard let data = Data(base64Encoded: command.samplesBase64) else {
            throw HelperError.invalidAudioPayload
        }

        let chunkSamples = try decodeSamples(from: data)
        guard !chunkSamples.isEmpty else {
            return
        }

        var state = streamState(for: command.stream)
        let expectedStart = state.bufferStartTimeSec + Double(state.samples.count) / Double(sampleRate)
        let gap = command.chunkStartTimeSec - expectedStart

        if state.samples.isEmpty {
            state.bufferStartTimeSec = command.chunkStartTimeSec
        } else if gap > 0.05 {
            let silenceCount = Int(gap * Double(sampleRate))
            state.samples.append(contentsOf: Array(repeating: 0, count: silenceCount))
        }

        state.samples.append(contentsOf: chunkSamples)
        state.lastAppendAt = Date()
        updateActivityState(&state, with: chunkSamples)
        state.idleFlushGeneration += 1

        let idleGeneration = state.idleFlushGeneration
        let currentSessionGeneration = sessionGeneration
        let source = command.stream
        streams[source] = state

        scheduleInferenceIfNeeded(for: source, force: false)

        Task {
            try? await Task.sleep(nanoseconds: UInt64(idleInferenceSeconds * 1_000_000_000))
            await self.flushIfIdle(
                for: source,
                idleGeneration: idleGeneration,
                sessionGeneration: currentSessionGeneration
            )
        }
    }

    func stopSession(_ command: StopSessionCommand) async throws {
        try validate(sessionId: command.sessionId)
        stopping = true
        sessionGeneration += 1
        pendingSources.removeAll()
        pendingSourceSet.removeAll()

        while activeSource != nil {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }

        if command.flush {
            for source in StreamSource.allCases where shouldFlushOnStop(for: source) {
                await runInferencePass(for: source, force: true)
            }
        }

        cancelDrainLoop()
        pendingSources.removeAll()
        pendingSourceSet.removeAll()
        activeSource = nil
        streams = [:]
        sessionId = nil
        stopping = false
        EventWriter.write(SessionStoppedEvent(sessionId: command.sessionId))
    }

    func shutdown() {
        sessionGeneration += 1
        cancelDrainLoop()
        pendingSources.removeAll()
        pendingSourceSet.removeAll()
        activeSource = nil
        streams = [:]
        sessionId = nil
        stopping = true
        whisperKit = nil
    }

    private func validate(sessionId: String) throws {
        guard self.sessionId == sessionId else {
            throw HelperError.invalidSession(sessionId)
        }
    }

    private func streamState(for source: StreamSource) -> StreamState {
        streams[source] ?? StreamState()
    }

    private func scheduleInferenceIfNeeded(for source: StreamSource, force: Bool) {
        guard let state = streams[source] else {
            return
        }

        let newSampleCount = max(0, state.samples.count - state.lastInferenceSampleCount)
        let reachedTimingThreshold = force
            || Double(newSampleCount) / Double(sampleRate) >= eagerInferenceSeconds
            || (newSampleCount > 0 && Date().timeIntervalSince(state.lastInferenceAt) >= idleInferenceSeconds)
        let sawActivity = force || hasActivitySinceLastInference(state)

        guard reachedTimingThreshold && sawActivity else {
            return
        }
        guard activeSource != source else {
            return
        }

        enqueuePendingSource(source)
        ensureDrainLoopRunning(for: sessionGeneration)
    }

    private func flushIfIdle(for source: StreamSource, idleGeneration: Int, sessionGeneration: Int) async {
        guard !stopping else {
            return
        }
        guard sessionGeneration == self.sessionGeneration else {
            return
        }

        let state = streamState(for: source)
        guard state.idleFlushGeneration == idleGeneration else {
            return
        }
        guard !state.isTranscribing else {
            return
        }
        guard Date().timeIntervalSince(state.lastAppendAt) >= idleInferenceSeconds else {
            return
        }

        guard shouldForceFlushAfterSilence(state) else {
            return
        }

        scheduleInferenceIfNeeded(for: source, force: true)
    }

    private func ensureDrainLoopRunning(for sessionGeneration: Int) {
        guard drainTask == nil else {
            return
        }

        drainTaskGeneration = sessionGeneration
        drainTask = Task {
            await self.runDrainLoop(expectedGeneration: sessionGeneration)
        }
    }

    private func runDrainLoop(expectedGeneration: Int) async {
        while !Task.isCancelled {
            guard expectedGeneration == sessionGeneration else {
                break
            }
            guard let source = dequeuePendingSource() else {
                break
            }

            await runInferencePass(for: source, force: false)
        }

        if drainTaskGeneration == expectedGeneration {
            drainTask = nil
            drainTaskGeneration = nil
        }
    }

    private func enqueuePendingSource(_ source: StreamSource) {
        guard pendingSourceSet.insert(source).inserted else {
            return
        }
        pendingSources.append(source)
    }

    private func dequeuePendingSource() -> StreamSource? {
        while !pendingSources.isEmpty {
            let source = pendingSources.removeFirst()
            pendingSourceSet.remove(source)
            if streams[source] != nil {
                return source
            }
        }

        return nil
    }

    private func cancelDrainLoop() {
        drainTask?.cancel()
        drainTask = nil
        drainTaskGeneration = nil
    }

    private func runInferencePass(for source: StreamSource, force: Bool) async {
        guard var state = streams[source] else {
            return
        }
        guard let whisperKit else {
            if !stopping {
                emitWarning(code: "whisper_unavailable", message: HelperError.whisperUnavailable.description, stream: source)
            }
            return
        }

        let clipStart = max(0, state.lastEmittedEndSec - state.bufferStartTimeSec)
        let options = DecodingOptions(
            verbose: false,
            skipSpecialTokens: true,
            withoutTimestamps: false,
            wordTimestamps: false,
            clipTimestamps: clipStart > 0 ? [Float(clipStart)] : [],
            suppressBlank: true,
            concurrentWorkerCount: 1
        )

        activeSource = source
        state.isTranscribing = true
        state.lastInferenceAt = Date()
        state.lastInferenceSampleCount = state.samples.count
        streams[source] = state

        defer {
            finishInference(for: source, shouldReevaluate: !force)
        }

        do {
            let results = try await whisperKit.transcribe(
                audioArray: state.samples,
                decodeOptions: options,
                callback: nil
            )

            guard let currentSessionId = sessionId else {
                return
            }

            var updatedState = streamState(for: source)
            var emittedSegmentCount = 0
            for result in results {
                for segment in result.segments {
                    let text = sanitizeTranscriptionText(segment.text)
                    if text.isEmpty {
                        continue
                    }

                    let absoluteStart = Double(segment.start) + updatedState.bufferStartTimeSec
                    let absoluteEnd = Double(segment.end) + updatedState.bufferStartTimeSec
                    if absoluteEnd <= updatedState.lastEmittedEndSec + 0.001 {
                        continue
                    }
                    if text == updatedState.lastEmittedText && abs(absoluteEnd - updatedState.lastEmittedEndSec) < 0.01 {
                        continue
                    }

                    EventWriter.write(
                        SegmentEvent(
                            sessionId: currentSessionId,
                            stream: source,
                            sequence: updatedState.sequence,
                            text: text,
                            startTimeSec: absoluteStart,
                            endTimeSec: absoluteEnd
                        )
                    )
                    updatedState.lastEmittedEndSec = absoluteEnd
                    updatedState.lastEmittedText = text
                    updatedState.sequence += 1
                    emittedSegmentCount += 1
                }
            }

            updatedState.lastInferenceProducedOutput = emittedSegmentCount > 0
            trimBufferIfNeeded(&updatedState)
            streams[source] = updatedState
        } catch {
            if error is CancellationError && stopping {
                return
            }
            emitWarning(code: "transcription_failed", message: String(describing: error), stream: source)
        }
    }

    private func finishInference(for source: StreamSource, shouldReevaluate: Bool) {
        guard var state = streams[source] else {
            if activeSource == source {
                activeSource = nil
            }
            return
        }

        state.isTranscribing = false
        streams[source] = state

        if activeSource == source {
            activeSource = nil
        }

        if shouldReevaluate && !stopping {
            scheduleInferenceIfNeeded(for: source, force: false)
        }
    }

    private func emitWarning(code: String, message: String, stream: StreamSource?) {
        EventWriter.write(WarningEvent(code: code, message: message, stream: stream))
    }

    private func updateActivityState(_ state: inout StreamState, with chunkSamples: [Float]) {
        var energy: Double = 0
        var peak: Float = 0

        for sample in chunkSamples {
            let amplitude = abs(sample)
            peak = max(peak, amplitude)
            energy += Double(sample * sample)
        }

        let rms = sqrt(energy / Double(chunkSamples.count))
        state.lastChunkPeak = peak
        if rms >= Double(activityRmsThreshold) || peak >= activityPeakThreshold {
            state.lastActivitySampleCount = state.samples.count
        }
    }

    private func hasActivitySinceLastInference(_ state: StreamState) -> Bool {
        state.lastActivitySampleCount > state.lastInferenceSampleCount
    }

    private func hasPendingAudioSinceLastInference(_ state: StreamState) -> Bool {
        state.samples.count > state.lastInferenceSampleCount
    }

    private func shouldForceFlushAfterSilence(_ state: StreamState) -> Bool {
        guard hasPendingAudioSinceLastInference(state) else {
            return false
        }
        guard state.lastActivitySampleCount > 0 else {
            return false
        }

        return !state.lastInferenceProducedOutput || hasActivitySinceLastInference(state)
    }

    private func shouldFlushOnStop(for source: StreamSource) -> Bool {
        guard let state = streams[source] else {
            return false
        }

        return shouldForceFlushAfterSilence(state)
    }

    private func sanitizeTranscriptionText(_ text: String) -> String {
        let withoutSpecialTokens = text.replacingOccurrences(
            of: #"<\|[^|]+?\|>"#,
            with: " ",
            options: .regularExpression
        )
        let collapsedWhitespace = withoutSpecialTokens.replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression
        )
        return collapsedWhitespace.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func trimBufferIfNeeded(_ state: inout StreamState) {
        let trimUntil = max(0, state.lastEmittedEndSec - trimContextSeconds - state.bufferStartTimeSec)
        let trimSampleCount = Int(trimUntil * Double(sampleRate))
        guard trimSampleCount > 0, trimSampleCount < state.samples.count else {
            return
        }

        state.samples.removeFirst(trimSampleCount)
        state.bufferStartTimeSec += Double(trimSampleCount) / Double(sampleRate)
        state.lastInferenceSampleCount = max(0, state.lastInferenceSampleCount - trimSampleCount)
        state.lastActivitySampleCount = max(0, state.lastActivitySampleCount - trimSampleCount)
    }

    private func decodeSamples(from data: Data) throws -> [Float] {
        guard data.count % MemoryLayout<Float>.size == 0 else {
            throw HelperError.invalidAudioPayload
        }

        let count = data.count / MemoryLayout<Float>.size
        return data.withUnsafeBytes { rawBuffer in
            Array(rawBuffer.bindMemory(to: Float.self).prefix(count))
        }
    }
}
