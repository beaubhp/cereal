cmake_minimum_required(VERSION 3.15)

project(hello)

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
add_library(hello SHARED
  hello_addon.mm
)

# Set properties for Node.js native addon
set_target_properties(hello PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  CXX_STANDARD 17
)

# Compile .mm files as ObjC++
set_source_files_properties(hello_addon.mm PROPERTIES
  COMPILE_FLAGS "-x objective-c++ -fmodules"
)

# Link cmake-js and macOS frameworks
target_link_libraries(hello
  ${CMAKE_JS_LIB}
  "-framework Foundation"
  "-framework ScreenCaptureKit"
)

# N-API version
target_compile_definitions(hello PRIVATE
  NAPI_VERSION=4
  NAPI_DISABLE_CPP_EXCEPTIONS
)
