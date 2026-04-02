import Foundation

enum StreamSource: String, Codable, CaseIterable, Sendable {
    case mic
    case system
}

struct CommandEnvelope: Decodable {
    let type: String
}

struct InitializeCommand: Decodable {
    let type: String
    let modelPath: String
    let sampleRate: Int
    let segmentMode: String
}

struct StartSessionCommand: Decodable {
    let type: String
    let sessionId: String
    let streams: [StreamSource]
}

struct AppendAudioCommand: Decodable {
    let type: String
    let sessionId: String
    let stream: StreamSource
    let chunkStartTimeSec: Double
    let sampleRate: Int
    let samplesBase64: String
}

struct StopSessionCommand: Decodable {
    let type: String
    let sessionId: String
    let flush: Bool
}

struct ShutdownCommand: Decodable {
    let type: String
}

enum HelperCommand: Sendable {
    case initialize(InitializeCommand)
    case startSession(StartSessionCommand)
    case appendAudio(AppendAudioCommand)
    case stopSession(StopSessionCommand)
    case shutdown

    static func decode(from line: String) throws -> HelperCommand {
        let data = Data(line.utf8)
        let decoder = JSONDecoder()
        let envelope = try decoder.decode(CommandEnvelope.self, from: data)

        switch envelope.type {
        case "initialize":
            return .initialize(try decoder.decode(InitializeCommand.self, from: data))
        case "start_session":
            return .startSession(try decoder.decode(StartSessionCommand.self, from: data))
        case "append_audio":
            return .appendAudio(try decoder.decode(AppendAudioCommand.self, from: data))
        case "stop_session":
            return .stopSession(try decoder.decode(StopSessionCommand.self, from: data))
        case "shutdown":
            return .shutdown
        default:
            throw HelperError.invalidCommandType(envelope.type)
        }
    }
}

struct InitializedEvent: Encodable {
    let type = "initialized"
    let model: String
}

struct SessionStartedEvent: Encodable {
    let type = "session_started"
    let sessionId: String
}

struct SegmentEvent: Encodable {
    let type = "segment"
    let sessionId: String
    let stream: StreamSource
    let sequence: Int
    let text: String
    let startTimeSec: Double
    let endTimeSec: Double
}

struct WarningEvent: Encodable {
    let type = "warning"
    let code: String
    let message: String
    let stream: StreamSource?
}

struct SessionStoppedEvent: Encodable {
    let type = "session_stopped"
    let sessionId: String
}

struct FatalEvent: Encodable {
    let type = "fatal"
    let code: String
    let message: String
}

enum HelperError: Error, CustomStringConvertible {
    case invalidCommandType(String)
    case invalidSession(String)
    case invalidSampleRate(Int)
    case invalidSegmentMode(String)
    case invalidAudioPayload
    case missingModel(String)
    case whisperUnavailable

    var description: String {
        switch self {
        case let .invalidCommandType(value):
            return "Unsupported command type: \(value)"
        case let .invalidSession(value):
            return "Unknown or inactive session: \(value)"
        case let .invalidSampleRate(value):
            return "Unsupported sample rate: \(value)"
        case let .invalidSegmentMode(value):
            return "Unsupported segment mode: \(value)"
        case .invalidAudioPayload:
            return "Audio payload is not valid Float32 PCM data"
        case let .missingModel(path):
            return "Model directory does not exist: \(path)"
        case .whisperUnavailable:
            return "WhisperKit is not initialized"
        }
    }
}

enum EventWriter {
    private static let encoder = JSONEncoder()

    static func write<T: Encodable>(_ value: T) {
        do {
            let data = try encoder.encode(value)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            fputs("Failed to encode helper event: \(error)\n", stderr)
        }
    }
}
