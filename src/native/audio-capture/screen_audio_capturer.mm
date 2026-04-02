#import "screen_audio_capturer.h"
#import "audio_capture_addon.h"
#import <CoreMedia/CoreMedia.h>

@implementation ScreenAudioCapturer {
    SCStream *_stream;
    napi_threadsafe_function _tsfn;
    BOOL _running;
    BOOL _starting;
    BOOL _stopRequested;
    dispatch_queue_t _captureQueue;
    void (^_pendingStopCompletion)(NSError *);
}

- (instancetype)initWithTSFN:(napi_threadsafe_function)tsfn {
    self = [super init];
    if (self) {
        _tsfn = tsfn;
        _running = NO;
        _starting = NO;
        _stopRequested = NO;
        _captureQueue = dispatch_queue_create("com.cereal.screen-audio-capture",
                                               DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)finishPendingStopWithError:(NSError *)error {
    void (^pendingStopCompletion)(NSError *) = _pendingStopCompletion;
    _pendingStopCompletion = nil;
    _stream = nil;
    _running = NO;
    _starting = NO;
    _stopRequested = NO;

    if (pendingStopCompletion) {
        pendingStopCompletion(error);
    }
}

- (void)stopActiveStreamWithCompletion:(void (^)(NSError *))completion {
    if (!_stream) {
        completion(nil);
        return;
    }

    [_stream stopCaptureWithCompletionHandler:^(NSError *error) {
        self->_stream = nil;
        self->_running = NO;
        completion(error);
    }];
}

- (void)startWithSampleRate:(double)sampleRate
                 completion:(void (^)(NSError *))completion {
    if (_running || _starting) {
        NSError *err = [NSError errorWithDomain:@"ScreenAudioCapturer"
                                           code:1
                                       userInfo:@{NSLocalizedDescriptionKey: @"Already running"}];
        completion(err);
        return;
    }

    _starting = YES;
    _stopRequested = NO;

    // Enumerate shareable content to get the main display
    [SCShareableContent getShareableContentWithCompletionHandler:
        ^(SCShareableContent *content, NSError *error) {
        if (self->_stopRequested) {
            [self finishPendingStopWithError:nil];
            return;
        }

        if (error || !content) {
            self->_starting = NO;
            completion(error ?: [NSError errorWithDomain:@"ScreenAudioCapturer"
                                                    code:2
                                                userInfo:@{NSLocalizedDescriptionKey:
                                                    @"Failed to get shareable content"}]);
            return;
        }

        SCDisplay *display = content.displays.firstObject;
        if (!display) {
            self->_starting = NO;
            completion([NSError errorWithDomain:@"ScreenAudioCapturer"
                                          code:3
                                      userInfo:@{NSLocalizedDescriptionKey:
                                          @"No displays found"}]);
            return;
        }

        // Get our own app to exclude from capture
        NSRunningApplication *currentApp = [NSRunningApplication currentApplication];
        NSMutableArray<SCRunningApplication *> *excludedApps = [NSMutableArray array];
        for (SCRunningApplication *app in content.applications) {
            if ([app.bundleIdentifier isEqualToString:currentApp.bundleIdentifier]) {
                [excludedApps addObject:app];
                break;
            }
        }

        // Create content filter for display audio, excluding our app
        SCContentFilter *filter = [[SCContentFilter alloc]
            initWithDisplay:display
            excludingApplications:excludedApps
            exceptingWindows:@[]];

        // Configure for audio-only capture
        SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
        config.capturesAudio = YES;
        config.excludesCurrentProcessAudio = YES;
        config.channelCount = 1;
        config.sampleRate = (NSInteger)sampleRate;
        // Minimize video overhead — we only want audio
        config.width = 2;
        config.height = 2;
        config.minimumFrameInterval = CMTimeMake(1, 1); // 1 fps minimum

        // Create and configure the stream
        self->_stream = [[SCStream alloc] initWithFilter:filter
                                           configuration:config
                                                delegate:self];

        NSError *addOutputError = nil;
        [self->_stream addStreamOutput:self
                                  type:SCStreamOutputTypeAudio
                    sampleHandlerQueue:self->_captureQueue
                                 error:&addOutputError];
        if (addOutputError) {
            self->_stream = nil;
            self->_starting = NO;
            completion(addOutputError);
            return;
        }

        if (self->_stopRequested) {
            [self finishPendingStopWithError:nil];
            return;
        }

        // Start capturing
        [self->_stream startCaptureWithCompletionHandler:^(NSError *startError) {
            self->_starting = NO;

            if (startError) {
                self->_stream = nil;
                if (self->_stopRequested) {
                    [self finishPendingStopWithError:nil];
                } else {
                    completion(startError);
                }
            } else {
                self->_running = YES;
                if (self->_stopRequested) {
                    [self stopActiveStreamWithCompletion:^(NSError *stopError) {
                        [self finishPendingStopWithError:stopError];
                    }];
                } else {
                    completion(nil);
                }
            }
        }];
    }];
}

- (void)stopWithCompletion:(void (^)(NSError *))completion {
    if (_stopRequested) {
        if (completion) {
            completion(nil);
        }
        return;
    }

    if (_starting && !_running) {
        _stopRequested = YES;
        _pendingStopCompletion = [completion copy];
        return;
    }

    if (!_running || !_stream) {
        completion(nil);
        return;
    }

    _stopRequested = YES;
    [self stopActiveStreamWithCompletion:^(NSError *error) {
        self->_starting = NO;
        self->_stopRequested = NO;
        completion(error);
    }];
}

- (void)detachTSFNOnCaptureQueueWithCompletion:(dispatch_block_t)completion {
    dispatch_async(_captureQueue, ^{
        self->_tsfn = nullptr;
        if (completion) {
            completion();
        }
    });
}

#pragma mark - SCStreamOutput

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio) return;
    if (!CMSampleBufferDataIsReady(sampleBuffer)) return;
    if (_tsfn == nullptr) return;

    // Get the audio buffer list
    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (!blockBuffer) return;

    size_t totalLength = 0;
    size_t lengthAtOffset = 0;
    char *dataPointer = NULL;

    OSStatus status = CMBlockBufferGetDataPointer(blockBuffer, 0, &lengthAtOffset,
                                                   &totalLength, &dataPointer);
    if (status != kCMBlockBufferNoErr || !dataPointer) return;

    // Get format description to determine sample format
    CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
    if (!formatDesc) return;

    const AudioStreamBasicDescription *asbd =
        CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
    if (!asbd) return;

    size_t sampleCount;
    float *floatSamples = nullptr;

    if (asbd->mFormatFlags & kAudioFormatFlagIsFloat) {
        // Already Float32
        sampleCount = totalLength / sizeof(float);
        floatSamples = new float[sampleCount];
        memcpy(floatSamples, dataPointer, totalLength);
    } else if (asbd->mBitsPerChannel == 16) {
        // Int16 → Float32 conversion
        sampleCount = totalLength / sizeof(int16_t);
        floatSamples = new float[sampleCount];
        const int16_t *int16Data = reinterpret_cast<const int16_t *>(dataPointer);
        for (size_t i = 0; i < sampleCount; i++) {
            floatSamples[i] = static_cast<float>(int16Data[i]) / 32768.0f;
        }
    } else if (asbd->mBitsPerChannel == 32) {
        // Int32 → Float32 conversion
        sampleCount = totalLength / sizeof(int32_t);
        floatSamples = new float[sampleCount];
        const int32_t *int32Data = reinterpret_cast<const int32_t *>(dataPointer);
        for (size_t i = 0; i < sampleCount; i++) {
            floatSamples[i] = static_cast<float>(int32Data[i]) / 2147483648.0f;
        }
    } else {
        return; // Unsupported format
    }

    // Get timestamp
    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    double timestamp = CMTimeGetSeconds(pts);

    auto *chunk = new AudioChunkData();
    chunk->samples = floatSamples;
    chunk->sampleCount = sampleCount;
    chunk->timestamp = timestamp;

    napi_status napiStatus = napi_call_threadsafe_function(_tsfn, chunk, napi_tsfn_nonblocking);
    if (napiStatus != napi_ok) {
        delete chunk;
    }
}

#pragma mark - SCStreamDelegate

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    _running = NO;
    _stream = nil;
    if (self.onError) {
        self.onError(error);
    }
}

@end
