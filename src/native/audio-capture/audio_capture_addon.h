#pragma once

#import <Foundation/Foundation.h>
#import <napi.h>

// Forward declarations for ObjC classes
@class MicCapturer;
@class ScreenAudioCapturer;

// Capture state enum
enum class CaptureState {
    Idle,
    Starting,
    Recording,
    Stopping
};

// Audio chunk data passed through TSFN
struct AudioChunkData {
    float* samples;
    size_t sampleCount;
    double timestamp;

    ~AudioChunkData() {
        delete[] samples;
    }
};
