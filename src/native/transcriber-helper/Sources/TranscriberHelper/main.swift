import Dispatch
import Foundation

let pipeline = WhisperPipeline()

while let line = readLine() {
    guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        continue
    }

    let semaphore = DispatchSemaphore(value: 0)
    Task {
        defer { semaphore.signal() }

        do {
            let command = try HelperCommand.decode(from: line)
            switch command {
            case let .initialize(value):
                try await pipeline.initialize(
                    modelPath: value.modelPath,
                    sampleRate: value.sampleRate,
                    segmentMode: value.segmentMode
                )
            case let .startSession(value):
                try await pipeline.startSession(sessionId: value.sessionId, streams: value.streams)
            case let .appendAudio(value):
                try await pipeline.appendAudio(value)
            case let .stopSession(value):
                try await pipeline.stopSession(value)
            case .shutdown:
                await pipeline.shutdown()
                exit(0)
            }
        } catch {
            EventWriter.write(
                FatalEvent(
                    code: "helper_command_failed",
                    message: error.localizedDescription
                )
            )
        }
    }

    semaphore.wait()
}
