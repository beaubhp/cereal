#import <Foundation/Foundation.h>
#import <napi.h>

// Check if ScreenCaptureKit is available at runtime
static bool isScreenCaptureKitAvailable() {
    // ScreenCaptureKit shipped in macOS 12.3+, though the app's
    // transcription runtime now targets macOS 14+ because of WhisperKit.
    if (@available(macOS 12.3, *)) {
        // Try to load the framework dynamically
        NSBundle *bundle = [NSBundle bundleWithPath:@"/System/Library/Frameworks/ScreenCaptureKit.framework"];
        return bundle != nil && [bundle load];
    }
    return false;
}

static Napi::Value GetSystemInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    // Get macOS version
    NSOperatingSystemVersion version = [[NSProcessInfo processInfo] operatingSystemVersion];
    NSString *versionString = [NSString stringWithFormat:@"%ld.%ld.%ld",
        (long)version.majorVersion,
        (long)version.minorVersion,
        (long)version.patchVersion];

    result.Set("macosVersion", std::string([versionString UTF8String]));
    result.Set("screenCaptureKitAvailable", isScreenCaptureKitAvailable());

    return result;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("getSystemInfo", Napi::Function::New(env, GetSystemInfo));
    return exports;
}

NODE_API_MODULE(hello, Init)
