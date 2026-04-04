#pragma once

#import <Foundation/Foundation.h>
#import <napi.h>

// POD struct for TSFN transfer — holds window titles for a given bundle ID
struct WindowQueryResult {
    char titles[20][512];  // Up to 20 window titles, 512 chars each
    int titleCount;
};

// NAPI-exported function (registered in audio_capture_addon.mm Init)
Napi::Value QueryBrowserWindows(const Napi::CallbackInfo &info);
