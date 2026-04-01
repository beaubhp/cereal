#import "mic_capturer.h"
#import "audio_capture_addon.h"
#import <mach/mach_time.h>

static double MicHostTimeToSeconds(uint64_t hostTime) {
    static mach_timebase_info_data_t timebaseInfo;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        mach_timebase_info(&timebaseInfo);
    });
    double nanos = (double)hostTime * (double)timebaseInfo.numer / (double)timebaseInfo.denom;
    return nanos / 1e9;
}

@implementation MicCapturer {
    AVAudioEngine *_engine;
    AVAudioMixerNode *_mixerNode;
    napi_threadsafe_function _tsfn;
    BOOL _running;
}

- (instancetype)initWithTSFN:(napi_threadsafe_function)tsfn {
    self = [super init];
    if (self) {
        _tsfn = tsfn;
        _running = NO;
    }
    return self;
}

- (BOOL)startWithSampleRate:(double)sampleRate error:(NSError **)error {
    if (_running) {
        if (error) {
            *error = [NSError errorWithDomain:@"MicCapturer"
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey: @"Already running"}];
        }
        return NO;
    }

    _engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *inputNode = [_engine inputNode];

    // AVAudioInputNode rejects taps with non-native formats. Route through a
    // mixer node instead — the engine handles sample rate conversion internally.
    AVAudioFormat *targetFormat = [[AVAudioFormat alloc]
        initStandardFormatWithSampleRate:sampleRate
                                channels:1];

    _mixerNode = [[AVAudioMixerNode alloc] init];
    [_engine attachNode:_mixerNode];
    [_engine connect:inputNode to:_mixerNode format:nil];
    [_engine connect:_mixerNode to:[_engine mainMixerNode] format:targetFormat];

    // Mute the engine output. AVAudioEngine requires all non-output nodes to
    // have a downstream connection (to mainMixerNode) or it refuses to start,
    // but this is a capture-only pipeline — we never want mic audio playing
    // back through the speakers. Setting outputVolume to 0 on this engine's
    // mainMixerNode silences it without affecting any other engine instance.
    [_engine mainMixerNode].outputVolume = 0.0f;

    // Buffer size of 4096 at 16kHz ≈ 256ms chunks
    napi_threadsafe_function tsfn = _tsfn;

    [_mixerNode installTapOnBus:0
                     bufferSize:4096
                         format:nil
                          block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        if (!buffer || buffer.frameLength == 0) return;

        const float *channelData = buffer.floatChannelData[0];
        size_t frameCount = buffer.frameLength;

        // Copy audio data - the buffer is only valid during this callback
        auto *chunk = new AudioChunkData();
        chunk->samples = new float[frameCount];
        memcpy(chunk->samples, channelData, frameCount * sizeof(float));
        chunk->sampleCount = frameCount;
        chunk->timestamp = when.isHostTimeValid
            ? MicHostTimeToSeconds(when.hostTime)
            : MicHostTimeToSeconds(mach_absolute_time());

        napi_call_threadsafe_function(tsfn, chunk, napi_tsfn_nonblocking);
    }];

    NSError *startError = nil;
    [_engine startAndReturnError:&startError];
    if (startError) {
        [_mixerNode removeTapOnBus:0];
        _mixerNode = nil;
        _engine = nil;
        if (error) *error = startError;
        return NO;
    }

    _running = YES;
    return YES;
}

- (void)stop {
    if (!_running) return;

    [_mixerNode removeTapOnBus:0];
    [_engine stop];
    _mixerNode = nil;
    _engine = nil;
    _running = NO;
}

@end
