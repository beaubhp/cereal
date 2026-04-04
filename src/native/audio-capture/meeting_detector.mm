#import "meeting_detector.h"
#import <CoreAudio/CoreAudio.h>
#import <AppKit/AppKit.h>

// Global state — all mutations dispatched to main queue for thread safety
static napi_threadsafe_function g_meetingTSFN = nullptr;
static bool g_monitoring = false;

// Listener block for process list changes on kAudioObjectSystemObject
static AudioObjectPropertyListenerBlock g_processListBlock = nil;

// Map of AudioObjectID (as NSNumber) -> listener block for per-process input state
static NSMutableDictionary<NSNumber *, id> *g_inputListenerBlocks = nil;

// Track which processes we've already reported as mic-active (avoid duplicate events)
static NSMutableSet<NSNumber *> *g_activeMicProcesses = nil;

// --- Helpers ---

static NSString *GetProcessBundleId(AudioObjectID processID) {
    AudioObjectPropertyAddress addr = {
        .mSelector = 'pbid', // kAudioProcessPropertyBundleID
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    CFStringRef bundleIdRef = nullptr;
    UInt32 size = sizeof(CFStringRef);
    OSStatus status = AudioObjectGetPropertyData(processID, &addr, 0, nullptr, &size, &bundleIdRef);
    if (status != noErr || !bundleIdRef) return nil;

    NSString *bundleId = (NSString *)CFBridgingRelease(bundleIdRef);
    return bundleId;
}

static NSString *GetProcessName(NSString *bundleId) {
    if (!bundleId) return @"Unknown";
    NSArray<NSRunningApplication *> *apps =
        [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId];
    if (apps.count > 0) {
        return apps.firstObject.localizedName ?: bundleId;
    }
    return bundleId;
}

static void FireMeetingEvent(NSString *bundleId, NSString *appName, bool micActive) {
    if (!g_meetingTSFN) return;

    auto *event = new MeetingEventData();
    strlcpy(event->bundleId,
            bundleId ? bundleId.UTF8String : "",
            sizeof(event->bundleId));
    strlcpy(event->appName,
            appName ? appName.UTF8String : "",
            sizeof(event->appName));
    event->micActive = micActive;

    napi_status status = napi_call_threadsafe_function(g_meetingTSFN, event, napi_tsfn_nonblocking);
    if (status != napi_ok) {
        delete event;
    }
}

static void CheckProcessInputState(AudioObjectID processID) {
    NSString *bundleId = GetProcessBundleId(processID);
    if (!bundleId || bundleId.length == 0) return;

    // Skip our own process
    NSString *myBundleId = [[NSRunningApplication currentApplication] bundleIdentifier];
    if (myBundleId && [bundleId isEqualToString:myBundleId]) return;

    AudioObjectPropertyAddress addr = {
        .mSelector = 'piri', // kAudioProcessPropertyIsRunningInput
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    UInt32 isRunning = 0;
    UInt32 size = sizeof(isRunning);
    OSStatus status = AudioObjectGetPropertyData(processID, &addr, 0, nullptr, &size, &isRunning);
    if (status != noErr) return;

    NSNumber *key = @(processID);
    bool wasActive = [g_activeMicProcesses containsObject:key];

    if (isRunning && !wasActive) {
        [g_activeMicProcesses addObject:key];
        NSString *appName = GetProcessName(bundleId);
        FireMeetingEvent(bundleId, appName, true);
    } else if (!isRunning && wasActive) {
        [g_activeMicProcesses removeObject:key];
        NSString *appName = GetProcessName(bundleId);
        FireMeetingEvent(bundleId, appName, false);
    }
}

static void AddInputListenerForProcess(AudioObjectID processID) {
    NSNumber *key = @(processID);
    if (g_inputListenerBlocks[key]) return; // Already monitoring

    AudioObjectPropertyAddress addr = {
        .mSelector = 'piri', // kAudioProcessPropertyIsRunningInput
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    // Verify the property exists for this process before adding a listener
    if (!AudioObjectHasProperty(processID, &addr)) return;

    AudioObjectID capturedID = processID;
    AudioObjectPropertyListenerBlock block =
        ^(UInt32 inNumberAddresses, const AudioObjectPropertyAddress *inAddresses) {
            // Block runs on main queue (registered below), safe to access globals directly
            if (g_monitoring) {
                CheckProcessInputState(capturedID);
            }
        };

    OSStatus status = AudioObjectAddPropertyListenerBlock(processID, &addr,
                                                          dispatch_get_main_queue(), block);
    if (status == noErr) {
        g_inputListenerBlocks[key] = block;
        // Check current state immediately
        CheckProcessInputState(processID);
    }
}

static void RemoveInputListenerForProcess(AudioObjectID processID) {
    NSNumber *key = @(processID);
    id block = g_inputListenerBlocks[key];
    if (!block) return;

    AudioObjectPropertyAddress addr = {
        .mSelector = 'piri', // kAudioProcessPropertyIsRunningInput
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    AudioObjectRemovePropertyListenerBlock(processID, &addr,
                                            dispatch_get_main_queue(), block);
    [g_inputListenerBlocks removeObjectForKey:key];

    // If process was active, fire a deactivation event
    if ([g_activeMicProcesses containsObject:key]) {
        [g_activeMicProcesses removeObject:key];
        NSString *bundleId = GetProcessBundleId(processID);
        NSString *appName = GetProcessName(bundleId);
        FireMeetingEvent(bundleId, appName, false);
    }
}

static void SyncProcessList() {
    AudioObjectPropertyAddress addr = {
        .mSelector = 'prs#', // kAudioHardwarePropertyProcessObjectList
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    UInt32 dataSize = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,
                                                      &addr, 0, nullptr, &dataSize);
    if (status != noErr || dataSize == 0) return;

    UInt32 processCount = dataSize / sizeof(AudioObjectID);
    std::vector<AudioObjectID> processIDs(processCount);
    status = AudioObjectGetPropertyData(kAudioObjectSystemObject,
                                         &addr, 0, nullptr, &dataSize, processIDs.data());
    if (status != noErr) return;

    // Build set of current process IDs
    NSMutableSet<NSNumber *> *currentProcessSet = [NSMutableSet setWithCapacity:processCount];
    for (UInt32 i = 0; i < processCount; i++) {
        [currentProcessSet addObject:@(processIDs[i])];
    }

    // Remove listeners for processes that are gone
    NSArray<NSNumber *> *existingKeys = [g_inputListenerBlocks allKeys];
    for (NSNumber *key in existingKeys) {
        if (![currentProcessSet containsObject:key]) {
            RemoveInputListenerForProcess(key.unsignedIntValue);
        }
    }

    // Add listeners for new processes
    for (UInt32 i = 0; i < processCount; i++) {
        AddInputListenerForProcess(processIDs[i]);
    }
}

// --- TSFN callback ---

static void MeetingEventCallJS(napi_env env, napi_value jsCb, void *context, void *data) {
    if (!env || !data) {
        delete static_cast<MeetingEventData *>(data);
        return;
    }

    auto *event = static_cast<MeetingEventData *>(data);

    napi_value global;
    napi_get_global(env, &global);

    // Create JS object { bundleId, appName, micActive }
    napi_value jsEvent;
    napi_create_object(env, &jsEvent);

    napi_value bundleIdVal;
    napi_create_string_utf8(env, event->bundleId, NAPI_AUTO_LENGTH, &bundleIdVal);
    napi_set_named_property(env, jsEvent, "bundleId", bundleIdVal);

    napi_value appNameVal;
    napi_create_string_utf8(env, event->appName, NAPI_AUTO_LENGTH, &appNameVal);
    napi_set_named_property(env, jsEvent, "appName", appNameVal);

    napi_value micActiveVal;
    napi_get_boolean(env, event->micActive, &micActiveVal);
    napi_set_named_property(env, jsEvent, "micActive", micActiveVal);

    napi_value argv[1] = { jsEvent };
    napi_value result;
    napi_call_function(env, global, jsCb, 1, argv, &result);

    delete event;
}

// --- Exported NAPI functions ---

Napi::Value StartMeetingMonitor(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (g_monitoring) {
        Napi::Error::New(env, "Meeting monitor already running").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::Error::New(env, "startMeetingMonitor requires a callback").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Function callback = info[0].As<Napi::Function>();

    // Create TSFN for meeting events
    napi_value resource;
    napi_create_string_utf8(env, "meetingMonitorTSFN", NAPI_AUTO_LENGTH, &resource);
    napi_create_threadsafe_function(env, callback, nullptr, resource,
                                    0, 1, nullptr, nullptr, nullptr,
                                    MeetingEventCallJS, &g_meetingTSFN);

    g_inputListenerBlocks = [NSMutableDictionary dictionary];
    g_activeMicProcesses = [NSMutableSet set];

    // Listen for process list changes on the system audio object
    AudioObjectPropertyAddress processListAddr = {
        .mSelector = 'prs#', // kAudioHardwarePropertyProcessObjectList
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain
    };

    g_processListBlock =
        ^(UInt32 inNumberAddresses, const AudioObjectPropertyAddress *inAddresses) {
            // Block runs on main queue (registered below), safe to access globals directly
            if (g_monitoring) {
                SyncProcessList();
            }
        };

    OSStatus status = AudioObjectAddPropertyListenerBlock(
        kAudioObjectSystemObject, &processListAddr,
        dispatch_get_main_queue(), g_processListBlock);

    if (status != noErr) {
        napi_release_threadsafe_function(g_meetingTSFN, napi_tsfn_release);
        g_meetingTSFN = nullptr;
        g_inputListenerBlocks = nil;
        g_activeMicProcesses = nil;
        g_processListBlock = nil;

        Napi::Error::New(env, "Failed to register CoreAudio process list listener")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    g_monitoring = true;

    // Sync immediately to pick up already-running processes
    SyncProcessList();

    return env.Undefined();
}

Napi::Value StopMeetingMonitor(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (!g_monitoring) {
        return env.Undefined();
    }

    g_monitoring = false;

    // Remove process list listener
    if (g_processListBlock) {
        AudioObjectPropertyAddress processListAddr = {
            .mSelector = 'prs#', // kAudioHardwarePropertyProcessObjectList
            .mScope = kAudioObjectPropertyScopeGlobal,
            .mElement = kAudioObjectPropertyElementMain
        };
        AudioObjectRemovePropertyListenerBlock(
            kAudioObjectSystemObject, &processListAddr,
            dispatch_get_main_queue(), g_processListBlock);
        g_processListBlock = nil;
    }

    // Remove all per-process input listeners
    if (g_inputListenerBlocks) {
        NSArray<NSNumber *> *keys = [g_inputListenerBlocks allKeys];
        for (NSNumber *key in keys) {
            AudioObjectID processID = key.unsignedIntValue;
            id block = g_inputListenerBlocks[key];

            AudioObjectPropertyAddress addr = {
                .mSelector = 'piri', // kAudioProcessPropertyIsRunningInput
                .mScope = kAudioObjectPropertyScopeGlobal,
                .mElement = kAudioObjectPropertyElementMain
            };
            AudioObjectRemovePropertyListenerBlock(processID, &addr,
                                                    dispatch_get_main_queue(), block);
        }
        g_inputListenerBlocks = nil;
    }

    g_activeMicProcesses = nil;

    // Release TSFN
    if (g_meetingTSFN) {
        napi_release_threadsafe_function(g_meetingTSFN, napi_tsfn_release);
        g_meetingTSFN = nullptr;
    }

    return env.Undefined();
}
