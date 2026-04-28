cmake_minimum_required(VERSION 3.15)

project(audio_capture)

# Find Node.js headers via cmake-js
include_directories(${CMAKE_JS_INC})

# Find node-addon-api headers
execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/../..
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
# Remove surrounding quotes if present
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
include_directories(${NODE_ADDON_API_DIR})

# Define the addon target
add_library(audio_capture SHARED
  audio_capture_addon.mm
  mic_capturer.mm
  screen_audio_capturer.mm
  meeting_detector.mm
  window_title_matcher.mm
)

# Set properties for Node.js native addon
set_target_properties(audio_capture PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  CXX_STANDARD 17
)

# Compile .mm files as ObjC++ with ARC enabled. Without -fobjc-arc, ObjC objects
# stored in globals/statics don't get retained on assignment, leading to dangling
# pointers when autorelease pools drain.
set_source_files_properties(
  audio_capture_addon.mm
  mic_capturer.mm
  screen_audio_capturer.mm
  meeting_detector.mm
  window_title_matcher.mm
  PROPERTIES COMPILE_FLAGS "-x objective-c++ -fmodules -fobjc-arc"
)

# Link cmake-js and macOS frameworks
target_link_libraries(audio_capture
  ${CMAKE_JS_LIB}
  "-framework Foundation"
  "-framework AppKit"
  "-framework ScreenCaptureKit"
  "-framework CoreMedia"
  "-framework AVFoundation"
  "-framework CoreAudio"
)

# N-API version
target_compile_definitions(audio_capture PRIVATE
  NAPI_VERSION=4
  NAPI_DISABLE_CPP_EXCEPTIONS
)
