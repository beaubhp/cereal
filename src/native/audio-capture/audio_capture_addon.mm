#import "audio_capture_addon.h"
#import "mic_capturer.h"
#import "screen_audio_capturer.h"
#import "meeting_detector.h"
#import "window_title_matcher.h"
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <mach/mach_time.h>

// Global state — all mutations must happen on the JS thread (main Node event loop)
static CaptureState g_state = CaptureState::Idle;
static MicCapturer *g_micCapturer = nil;
static ScreenAudioCapturer *g_screenCapturer = nil;
static napi_threadsafe_function g_micTSFN = nullptr;
static napi_threadsafe_function g_systemTSFN = nullptr;
static napi_threadsafe_function g_errorTSFN = nullptr;

// Mach timebase for converting hostTime to seconds
static mach_timebase_info_data_t g_timebaseInfo;
static bool g_timebaseInitialized = false;

static double hostTimeToSeconds(uint64_t hostTime) {
    if (!g_timebaseInitialized) {
        mach_timebase_info(&g_timebaseInfo);
        g_timebaseInitialized = true;
    }
    double nanos = (double)hostTime * (double)g_timebaseInfo.numer / (double)g_timebaseInfo.denom;
    return nanos / 1e9;
}

// TSFN callback that runs on the JS thread — converts native audio data to Float32Array
static void AudioChunkCallJS(napi_env env, napi_value jsCb, void *context, void *data) {
    if (!env || !data) {
        if (data) delete static_cast<AudioChunkData *>(data);
        return;
    }

    auto *chunk = static_cast<AudioChunkData *>(data);

    napi_value global;
    napi_get_global(env, &global);

    // Create Float32Array from chunk data
    napi_value arrayBuffer;
    void *bufferData;
    napi_create_arraybuffer(env, chunk->sampleCount * sizeof(float), &bufferData, &arrayBuffer);
    memcpy(bufferData, chunk->samples, chunk->sampleCount * sizeof(float));

    napi_value float32Array;
    napi_create_typedarray(env, napi_float32_array, chunk->sampleCount, arrayBuffer, 0, &float32Array);

    // Create timestamp value
    napi_value timestamp;
    napi_create_double(env, chunk->timestamp, &timestamp);

    // Call the JS callback with (samples, timestamp)
    napi_value argv[2] = { float32Array, timestamp };
    napi_value result;
    napi_call_function(env, global, jsCb, 2, argv, &result);

    delete chunk;
}

// Error data passed through TSFN — plain C string, no ObjC objects through void*
struct ErrorData {
    char message[256];
};

// Error TSFN callback — runs on JS thread
static void ErrorCallJS(napi_env env, napi_value jsCb, void *context, void *data) {
    if (!env || !data) {
        delete static_cast<ErrorData *>(data);
        return;
    }

    auto *errData = static_cast<ErrorData *>(data);

    napi_value global;
    napi_get_global(env, &global);

    napi_value errMsg;
    napi_create_string_utf8(env, errData->message, NAPI_AUTO_LENGTH, &errMsg);

    napi_value argv[1] = { errMsg };
    napi_value result;
    napi_call_function(env, global, jsCb, 1, argv, &result);

    delete errData;
}

// --- Permission checking ---

static Napi::Value CheckPermissions(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    // Check microphone permission
    AVAuthorizationStatus micStatus = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    switch (micStatus) {
        case AVAuthorizationStatusAuthorized:
            result.Set("microphone", "granted");
            break;
        case AVAuthorizationStatusDenied:
        case AVAuthorizationStatusRestricted:
            result.Set("microphone", "denied");
            break;
        case AVAuthorizationStatusNotDetermined:
        default:
            result.Set("microphone", "undetermined");
            break;
    }

    // Check screen recording permission
    if (@available(macOS 15.0, *)) {
        bool hasAccess = CGPreflightScreenCaptureAccess();
        result.Set("screenRecording", hasAccess ? "granted" : "denied");
    } else {
        // On macOS 12.3–14.x, probe via SCShareableContent enumeration.
        // If Screen Recording is not granted, the completion handler returns
        // an empty applications list (displays may still be returned).
        // This is a synchronous wait on an async API, but it's only used for
        // the permission check path which is called infrequently.
        __block bool hasAccess = false;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        [SCShareableContent getShareableContentWithCompletionHandler:
            ^(SCShareableContent *content, NSError *error) {
            if (!error && content && content.applications.count > 0) {
                hasAccess = true;
            }
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
        result.Set("screenRecording", hasAccess ? "granted" : "denied");
    }

    return result;
}

// RequestPermissions — uses a TSFN to resolve after the mic dialog is dismissed
struct PermissionResultData {
    bool micGranted;
};

static void PermissionResultCallJS(napi_env env, napi_value jsCb, void *context, void *data) {
    if (!env) return;

    auto *resultData = static_cast<PermissionResultData *>(data);
    (void)resultData; // mic result is informational; we re-check all permissions

    napi_value global;
    napi_get_global(env, &global);

    // Call the JS callback with no args — the TS layer re-checks permissions
    napi_value result;
    napi_call_function(env, global, jsCb, 0, nullptr, &result);

    delete resultData;
}

static Napi::Value RequestPermissions(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    // We need a callback to know when the mic dialog is dismissed
    // Use a TSFN so the completion handler (on a background thread) can signal JS
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::Error::New(env, "requestPermissions requires a callback").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Function callback = info[0].As<Napi::Function>();

    napi_threadsafe_function tsfn;
    napi_value resource;
    napi_create_string_utf8(env, "permissionRequestTSFN", NAPI_AUTO_LENGTH, &resource);
    napi_create_threadsafe_function(env, callback, nullptr, resource,
                                    0, 1, nullptr, nullptr, nullptr,
                                    PermissionResultCallJS, &tsfn);

    // Request screen recording (opens System Settings, non-blocking)
    // CGRequestScreenCaptureAccess() is available since macOS 10.15
    CGRequestScreenCaptureAccess();

    // Request microphone permission (shows dialog, async)
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL granted) {
        auto *resultData = new PermissionResultData();
        resultData->micGranted = granted;
        napi_call_threadsafe_function(tsfn, resultData, napi_tsfn_nonblocking);
        napi_release_threadsafe_function(tsfn, napi_tsfn_release);
    }];

    return env.Undefined();
}

// --- Audio capture ---

// Helper to clean up all capture state — must be called on JS thread only
static void CleanupCapture() {
    if (g_micCapturer) {
        [g_micCapturer stop];
        g_micCapturer = nil;
    }
    if (g_screenCapturer) {
        g_screenCapturer = nil;
    }
    if (g_micTSFN) {
        napi_release_threadsafe_function(g_micTSFN, napi_tsfn_release);
        g_micTSFN = nullptr;
    }
    if (g_systemTSFN) {
        napi_release_threadsafe_function(g_systemTSFN, napi_tsfn_release);
        g_systemTSFN = nullptr;
    }
    if (g_errorTSFN) {
        napi_release_threadsafe_function(g_errorTSFN, napi_tsfn_release);
        g_errorTSFN = nullptr;
    }
    g_state = CaptureState::Idle;
}

static Napi::Value StartCapture(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (g_state != CaptureState::Idle) {
        deferred.Reject(Napi::Error::New(env, "Capture already in progress").Value());
        return deferred.Promise();
    }

    // Parse config
    double sampleRate = 16000;
    if (info.Length() > 0 && info[0].IsObject()) {
        Napi::Object config = info[0].As<Napi::Object>();
        if (config.Has("sampleRate")) {
            sampleRate = config.Get("sampleRate").As<Napi::Number>().DoubleValue();
        }
    }

    // Validate callbacks: config, micCb, systemCb, errorCb
    if (info.Length() < 4 || !info[1].IsFunction() || !info[2].IsFunction() || !info[3].IsFunction()) {
        deferred.Reject(Napi::Error::New(env,
            "startCapture requires (config, micCallback, systemCallback, errorCallback)").Value());
        return deferred.Promise();
    }

    Napi::Function micCb = info[1].As<Napi::Function>();
    Napi::Function systemCb = info[2].As<Napi::Function>();
    Napi::Function errorCb = info[3].As<Napi::Function>();

    g_state = CaptureState::Starting;

    // Create TSFN for mic audio chunks
    napi_value micResource;
    napi_create_string_utf8(env, "micAudioTSFN", NAPI_AUTO_LENGTH, &micResource);
    napi_create_threadsafe_function(env, micCb, nullptr, micResource,
                                    0, 1, nullptr, nullptr, nullptr,
                                    AudioChunkCallJS, &g_micTSFN);

    // Create TSFN for system audio chunks
    napi_value sysResource;
    napi_create_string_utf8(env, "systemAudioTSFN", NAPI_AUTO_LENGTH, &sysResource);
    napi_create_threadsafe_function(env, systemCb, nullptr, sysResource,
                                    0, 1, nullptr, nullptr, nullptr,
                                    AudioChunkCallJS, &g_systemTSFN);

    // Create TSFN for error reporting
    napi_value errResource;
    napi_create_string_utf8(env, "errorTSFN", NAPI_AUTO_LENGTH, &errResource);
    napi_create_threadsafe_function(env, errorCb, nullptr, errResource,
                                    0, 1, nullptr, nullptr, nullptr,
                                    ErrorCallJS, &g_errorTSFN);

    // Create capturers
    g_micCapturer = [[MicCapturer alloc] initWithTSFN:g_micTSFN];
    g_screenCapturer = [[ScreenAudioCapturer alloc] initWithTSFN:g_systemTSFN];

    // Wire up SCK error handler — surfaces unexpected stops to JS
    napi_threadsafe_function errorTSFN = g_errorTSFN;
    g_screenCapturer.onError = ^(NSError *error) {
        auto *errData = new ErrorData();
        snprintf(errData->message, sizeof(errData->message),
                 "System audio stream stopped: %s",
                 error.localizedDescription.UTF8String);
        napi_call_threadsafe_function(errorTSFN, errData, napi_tsfn_nonblocking);
    };

    // Start mic capture (synchronous)
    NSError *micError = nil;
    BOOL micStarted = [g_micCapturer startWithSampleRate:sampleRate error:&micError];
    if (!micStarted) {
        CleanupCapture();
        std::string errMsg = "Mic capture failed: ";
        errMsg += micError.localizedDescription.UTF8String;
        deferred.Reject(Napi::Error::New(env, errMsg).Value());
        return deferred.Promise();
    }

    // Start system audio capture (async)
    // TODO: If stopCapture() is called before this completion fires, the stream
    // can end up running with released TSFNs. Add a cancelled/stopping guard here
    // that suppresses late starts. Low practical risk — SCK starts in milliseconds
    // and the app never rapid-toggles capture.
    [g_screenCapturer startWithSampleRate:sampleRate
                               completion:^(NSError *error) {
        if (error) {
            // System audio failed — log the error via error TSFN
            // Keep mic running so the user still gets "Me" audio
            auto *errData = new ErrorData();
            snprintf(errData->message, sizeof(errData->message),
                     "System audio capture failed (mic still active): %s",
                     error.localizedDescription.UTF8String);
            napi_call_threadsafe_function(errorTSFN, errData, napi_tsfn_nonblocking);

            // Release only the system TSFN since system capturer won't produce data
            napi_release_threadsafe_function(g_systemTSFN, napi_tsfn_release);
            g_systemTSFN = nullptr;
            g_screenCapturer = nil;
        }
        // State transitions to Recording regardless — mic is running
        g_state = CaptureState::Recording;
    }];

    // Resolve immediately — mic is started, system audio is starting async
    deferred.Resolve(env.Undefined());
    return deferred.Promise();
}

static Napi::Value StopCapture(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (g_state == CaptureState::Idle) {
        deferred.Resolve(env.Undefined());
        return deferred.Promise();
    }

    g_state = CaptureState::Stopping;

    // Stop mic (synchronous) — tap is removed, no more callbacks after this
    if (g_micCapturer) {
        [g_micCapturer stop];
        g_micCapturer = nil;
    }

    // Release mic TSFN — safe because tap has been removed
    if (g_micTSFN) {
        napi_release_threadsafe_function(g_micTSFN, napi_tsfn_release);
        g_micTSFN = nullptr;
    }

    // Stop system audio (async) — defer state transition until SCK confirms stop
    // TODO: Release the system TSFN via a block dispatched to _captureQueue AFTER
    // the stop completion, to ensure all in-flight didOutputSampleBuffer callbacks
    // have drained before the TSFN is freed. Currently harmless (napi returns
    // napi_closing on a released TSFN) but would leak an AudioChunkData.
    if (g_screenCapturer) {
        // Capture the TSFN pointer for the completion block
        napi_threadsafe_function systemTSFN = g_systemTSFN;
        napi_threadsafe_function errorTSFN = g_errorTSFN;
        g_systemTSFN = nullptr; // Prevent double-release
        g_errorTSFN = nullptr;

        [g_screenCapturer stopWithCompletion:^(NSError *error) {
            // Now it's safe to release — SCK has confirmed no more callbacks
            if (systemTSFN) {
                napi_release_threadsafe_function(systemTSFN, napi_tsfn_release);
            }
            if (errorTSFN) {
                napi_release_threadsafe_function(errorTSFN, napi_tsfn_release);
            }
            g_screenCapturer = nil;
            g_state = CaptureState::Idle;
        }];
    } else {
        // No screen capturer — clean up error TSFN and transition immediately
        if (g_errorTSFN) {
            napi_release_threadsafe_function(g_errorTSFN, napi_tsfn_release);
            g_errorTSFN = nullptr;
        }
        g_state = CaptureState::Idle;
    }

    deferred.Resolve(env.Undefined());
    return deferred.Promise();
}

static Napi::Value GetCaptureState(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    switch (g_state) {
        case CaptureState::Starting: return Napi::String::New(env, "starting");
        case CaptureState::Recording: return Napi::String::New(env, "recording");
        case CaptureState::Stopping: return Napi::String::New(env, "stopping");
        case CaptureState::Idle:
        default: return Napi::String::New(env, "idle");
    }
}

// --- Module init ---

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("checkPermissions", Napi::Function::New(env, CheckPermissions));
    exports.Set("requestPermissions", Napi::Function::New(env, RequestPermissions));
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
    exports.Set("getCaptureState", Napi::Function::New(env, GetCaptureState));
    exports.Set("startMeetingMonitor", Napi::Function::New(env, StartMeetingMonitor));
    exports.Set("stopMeetingMonitor", Napi::Function::New(env, StopMeetingMonitor));
    exports.Set("queryBrowserWindows", Napi::Function::New(env, QueryBrowserWindows));
    return exports;
}

NODE_API_MODULE(audio_capture, Init)
