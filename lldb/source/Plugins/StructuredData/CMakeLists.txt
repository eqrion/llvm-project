set_property(DIRECTORY PROPERTY LLDB_PLUGIN_KIND StructuredData)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  add_subdirectory(DarwinLog)
endif()

