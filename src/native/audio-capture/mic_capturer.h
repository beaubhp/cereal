#pragma once

#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <napi.h>

@interface MicCapturer : NSObject

- (instancetype)initWithTSFN:(napi_threadsafe_function)tsfn;
- (BOOL)startWithSampleRate:(double)sampleRate error:(NSError **)error;
- (void)stop;

@end
