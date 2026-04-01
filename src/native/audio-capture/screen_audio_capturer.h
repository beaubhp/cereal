#pragma once

#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <napi.h>

@interface ScreenAudioCapturer : NSObject <SCStreamDelegate, SCStreamOutput>

- (instancetype)initWithTSFN:(napi_threadsafe_function)tsfn;
- (void)startWithSampleRate:(double)sampleRate
                 completion:(void (^)(NSError *))completion;
- (void)stopWithCompletion:(void (^)(NSError *))completion;

@property (nonatomic, copy) void (^onError)(NSError *);

@end
