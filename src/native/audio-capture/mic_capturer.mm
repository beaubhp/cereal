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
    AVAudioFormat *inputFormat = [inputNode outputFormatForBus:0];
    if (inputFormat.channelCount == 0 || inputFormat.sampleRate <= 0) {
        if (error) {
            *error = [NSError errorWithDomain:@"MicCapturer"
                                         code:2
                                     userInfo:@{NSLocalizedDescriptionKey:
                                         @"Microphone input format is unavailable"}];
        }
        _engine = nil;
        return NO;
    }

    // Tap the hardware input directly in its native format, then explicitly
    // downmix/resample to 16 kHz mono before forwarding chunks to JS.
    AVAudioFormat *targetFormat = [[AVAudioFormat alloc]
        initStandardFormatWithSampleRate:sampleRate
                                channels:1];
    AVAudioConverter *converter = [[AVAudioConverter alloc]
        initFromFormat:inputFormat
              toFormat:targetFormat];
    if (!converter) {
        if (error) {
            *error = [NSError errorWithDomain:@"MicCapturer"
                                         code:3
                                     userInfo:@{NSLocalizedDescriptionKey:
                                         @"Failed to create microphone audio converter"}];
        }
        _engine = nil;
        return NO;
    }

    // Buffer size of 4096 at 16kHz ≈ 256ms chunks
    napi_threadsafe_function tsfn = _tsfn;

    [inputNode installTapOnBus:0
                     bufferSize:4096
                         format:inputFormat
                          block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        if (!buffer || buffer.frameLength == 0) return;

        AVAudioFrameCount convertedCapacity = (AVAudioFrameCount)MAX(
            1.0,
            ceil((double)buffer.frameLength * sampleRate / inputFormat.sampleRate)
        );
        AVAudioPCMBuffer *convertedBuffer = [[AVAudioPCMBuffer alloc]
            initWithPCMFormat:targetFormat
                frameCapacity:convertedCapacity];
        if (!convertedBuffer) return;

        __block BOOL suppliedInput = NO;
        NSError *conversionError = nil;
        AVAudioConverterOutputStatus status = [converter convertToBuffer:convertedBuffer
                                                                  error:&conversionError
                                                     withInputFromBlock:^AVAudioBuffer *_Nullable(
            AVAudioPacketCount inNumPackets,
            AVAudioConverterInputStatus *outStatus
        ) {
            if (suppliedInput) {
                *outStatus = AVAudioConverterInputStatus_NoDataNow;
                return nil;
            }

            suppliedInput = YES;
            *outStatus = AVAudioConverterInputStatus_HaveData;
            return buffer;
        }];

        if (status != AVAudioConverterOutputStatus_HaveData || convertedBuffer.frameLength == 0) {
            return;
        }

        const float *channelData = convertedBuffer.floatChannelData[0];
        if (!channelData) return;
        size_t frameCount = convertedBuffer.frameLength;

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
    [_engine prepare];
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

    [[_engine inputNode] removeTapOnBus:0];
    [_engine stop];
    _engine = nil;
    _running = NO;
}

@end
