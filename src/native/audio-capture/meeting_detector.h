#pragma once

#import <Foundation/Foundation.h>
#import <napi.h>

// POD struct for TSFN transfer (native thread → JS thread)
struct MeetingEventData {
    char bundleId[256];
    char appName[128];
    bool micActive;  // true = started using mic, false = stopped
};

// NAPI-exported functions (registered in audio_capture_addon.mm Init)
Napi::Value StartMeetingMonitor(const Napi::CallbackInfo &info);
Napi::Value StopMeetingMonitor(const Napi::CallbackInfo &info);
