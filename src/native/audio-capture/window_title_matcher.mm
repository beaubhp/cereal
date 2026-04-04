#import "window_title_matcher.h"
#import <ScreenCaptureKit/ScreenCaptureKit.h>

// TSFN callback — runs on JS thread, converts WindowQueryResult to JS string array
static void WindowQueryCallJS(napi_env env, napi_value jsCb, void *context, void *data) {
    if (!env || !data) {
        delete static_cast<WindowQueryResult *>(data);
        return;
    }

    auto *result = static_cast<WindowQueryResult *>(data);

    napi_value global;
    napi_get_global(env, &global);

    // Create JS array of title strings
    napi_value jsArray;
    napi_create_array_with_length(env, result->titleCount, &jsArray);

    for (int i = 0; i < result->titleCount; i++) {
        napi_value titleStr;
        napi_create_string_utf8(env, result->titles[i], NAPI_AUTO_LENGTH, &titleStr);
        napi_set_element(env, jsArray, i, titleStr);
    }

    napi_value argv[1] = { jsArray };
    napi_value callResult;
    napi_call_function(env, global, jsCb, 1, argv, &callResult);

    delete result;
}

Napi::Value QueryBrowserWindows(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        Napi::Error::New(env, "queryBrowserWindows requires (bundleId: string, callback: function)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string bundleIdStr = info[0].As<Napi::String>().Utf8Value();
    Napi::Function callback = info[1].As<Napi::Function>();

    // Create one-shot TSFN
    napi_threadsafe_function tsfn;
    napi_value resource;
    napi_create_string_utf8(env, "windowQueryTSFN", NAPI_AUTO_LENGTH, &resource);
    napi_create_threadsafe_function(env, callback, nullptr, resource,
                                    0, 1, nullptr, nullptr, nullptr,
                                    WindowQueryCallJS, &tsfn);

    // Capture bundleId for the async block
    NSString *targetBundleId = [NSString stringWithUTF8String:bundleIdStr.c_str()];

    // Query SCShareableContent for all windows (including minimized)
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                               onScreenWindowsOnly:NO
                                                 completionHandler:
        ^(SCShareableContent *content, NSError *error) {
            auto *result = new WindowQueryResult();
            result->titleCount = 0;

            if (!error && content) {
                for (SCWindow *window in content.windows) {
                    if (result->titleCount >= 20) break;

                    NSString *windowBundleId = window.owningApplication.bundleIdentifier;
                    if (!windowBundleId || ![windowBundleId isEqualToString:targetBundleId]) {
                        continue;
                    }

                    NSString *title = window.title;
                    if (!title || title.length == 0) continue;

                    strlcpy(result->titles[result->titleCount],
                            title.UTF8String,
                            sizeof(result->titles[result->titleCount]));
                    result->titleCount++;
                }
            }

            napi_call_threadsafe_function(tsfn, result, napi_tsfn_nonblocking);
            napi_release_threadsafe_function(tsfn, napi_tsfn_release);
        }];

    return env.Undefined();
}
