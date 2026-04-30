#pragma once

#import <Foundation/Foundation.h>
#import <napi.h>

// NAPI-exported functions (registered in audio_capture_addon.mm Init)
Napi::Value StartMeetingMonitor(const Napi::CallbackInfo &info);
Napi::Value StopMeetingMonitor(const Napi::CallbackInfo &info);
Napi::Value PollMeetingState(const Napi::CallbackInfo &info);
