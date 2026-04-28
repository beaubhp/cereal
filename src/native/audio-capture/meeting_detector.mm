#import "meeting_detector.h"
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

// Polling-based meeting detection. JS drives polling via setInterval and calls
// PollMeetingState; we return state-change deltas. CoreAudio queries are kept on
// the JS thread because background-queue calls (property listeners, dispatch
// timers) crash on some systems.
//
// ARC must be enabled for this file (see CMakeLists.txt) — without -fobjc-arc,
// the static dictionary below would not be retained on assignment.

static NSMutableDictionary<NSNumber *, NSString *> *g_activeMicProcesses = nil;

// --- Helpers ---

static NSString *GetProcessBundleId(AudioObjectID processID) {
    AudioObjectPropertyAddress addr = {
        .mSelector = 'pbid', // kAudioProcessPropertyBundleID
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    if (!AudioObjectHasProperty(processID, &addr)) return nil;

    CFStringRef bundleIdRef = nullptr;
    UInt32 size = sizeof(CFStringRef);
    OSStatus status = AudioObjectGetPropertyData(processID, &addr, 0, nullptr, &size, &bundleIdRef);
    if (status != noErr || !bundleIdRef) return nil;

    // Validate type — some CoreAudio process objects return non-CFString data
    // and CFBridgingRelease on a non-CFString crashes.
    if (CFGetTypeID(bundleIdRef) != CFStringGetTypeID()) {
        CFRelease(bundleIdRef);
        return nil;
    }

    return (NSString *)CFBridgingRelease(bundleIdRef);
}

static bool IsProcessRunningInput(AudioObjectID processID) {
    AudioObjectPropertyAddress addr = {
        .mSelector = 'piri', // kAudioProcessPropertyIsRunningInput
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    if (!AudioObjectHasProperty(processID, &addr)) return false;

    UInt32 isRunning = 0;
    UInt32 size = sizeof(isRunning);
    OSStatus status = AudioObjectGetPropertyData(processID, &addr, 0, nullptr, &size, &isRunning);
    if (status != noErr) return false;

    return isRunning != 0;
}

static std::vector<AudioObjectID> GetAudioProcessList() {
    std::vector<AudioObjectID> result;

    AudioObjectPropertyAddress addr = {
        .mSelector = 'prs#', // kAudioHardwarePropertyProcessObjectList
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    if (!AudioObjectHasProperty(kAudioObjectSystemObject, &addr)) return result;

    UInt32 dataSize = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &dataSize);
    if (status != noErr || dataSize == 0) return result;

    result.resize(dataSize / sizeof(AudioObjectID));
    status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &dataSize, result.data());
    if (status != noErr) {
        result.clear();
        return result;
    }
    result.resize(dataSize / sizeof(AudioObjectID));

    return result;
}

// --- Exported NAPI functions ---

// Returns the deltas in mic-using processes since the last call:
//   [{ bundleId: string, micActive: boolean }, ...]
Napi::Value PollMeetingState(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    Napi::Array events = Napi::Array::New(env);
    uint32_t eventIndex = 0;

    if (!g_activeMicProcesses) return events;

    std::vector<AudioObjectID> processIDs = GetAudioProcessList();

    NSMutableDictionary<NSNumber *, NSString *> *current = [NSMutableDictionary dictionary];
    NSString *myBundleId = [[NSBundle mainBundle] bundleIdentifier];

    // Get bundle ID first, then query piri. The reverse order has been observed
    // to crash CoreAudio on some systems.
    for (AudioObjectID pid : processIDs) {
        @autoreleasepool {
            NSString *bundleId = GetProcessBundleId(pid);
            if (!bundleId || bundleId.length == 0) continue;
            if (myBundleId && [bundleId isEqualToString:myBundleId]) continue;
            if (!IsProcessRunningInput(pid)) continue;

            current[@(pid)] = bundleId;
        }
    }

    NSDictionary<NSNumber *, NSString *> *previous = [g_activeMicProcesses copy];

    for (NSNumber *key in current) {
        if (!previous[key]) {
            Napi::Object evt = Napi::Object::New(env);
            evt.Set("bundleId", Napi::String::New(env, current[key].UTF8String));
            evt.Set("micActive", Napi::Boolean::New(env, true));
            events.Set(eventIndex++, evt);
        }
    }

    for (NSNumber *key in previous) {
        if (!current[key]) {
            Napi::Object evt = Napi::Object::New(env);
            evt.Set("bundleId", Napi::String::New(env, previous[key].UTF8String));
            evt.Set("micActive", Napi::Boolean::New(env, false));
            events.Set(eventIndex++, evt);
        }
    }

    g_activeMicProcesses = current;
    return events;
}

Napi::Value StartMeetingMonitor(const Napi::CallbackInfo &info) {
    g_activeMicProcesses = [NSMutableDictionary dictionary];
    return info.Env().Undefined();
}

Napi::Value StopMeetingMonitor(const Napi::CallbackInfo &info) {
    g_activeMicProcesses = nil;
    return info.Env().Undefined();
}
