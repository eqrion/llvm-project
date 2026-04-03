set_property(DIRECTORY PROPERTY LLDB_PLUGIN_KIND MemoryHistory)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  add_subdirectory(asan)
endif()
