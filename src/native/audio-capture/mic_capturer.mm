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

    // Target format: mono, specified sample rate, Float32
    AVAudioFormat *targetFormat = [[AVAudioFormat alloc]
        initStandardFormatWithSampleRate:sampleRate
                                channels:1];

    // Install tap on input node
    // Buffer size of 4096 at 16kHz = ~256ms chunks
    napi_threadsafe_function tsfn = _tsfn;

    [inputNode installTapOnBus:0
                    bufferSize:4096
                        format:targetFormat
                         block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        if (!buffer || buffer.frameLength == 0) return;

        const float *channelData = buffer.floatChannelData[0];
        size_t frameCount = buffer.frameLength;

        // Copy audio data - the buffer is only valid during this callback
        auto *chunk = new AudioChunkData();
        chunk->samples = new float[frameCount];
        memcpy(chunk->samples, channelData, frameCount * sizeof(float));
        chunk->sampleCount = frameCount;
        chunk->timestamp = MicHostTimeToSeconds(when.hostTime);

        napi_call_threadsafe_function(tsfn, chunk, napi_tsfn_nonblocking);
    }];

    NSError *startError = nil;
    [_engine startAndReturnError:&startError];
    if (startError) {
        [inputNode removeTapOnBus:0];
        _engine = nil;
        if (error) *error = startError;
        return NO;
    }

    _running = YES;
    return YES;
}

- (void)stop {
    if (!_running) return;

    AVAudioInputNode *inputNode = [_engine inputNode];
    [inputNode removeTapOnBus:0];
    [_engine stop];
    _engine = nil;
    _running = NO;
}

@end
