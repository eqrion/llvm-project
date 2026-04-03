set_property(DIRECTORY PROPERTY LLDB_PLUGIN_KIND TraceExporter)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  add_subdirectory(common)
  add_subdirectory(ctf)
endif()
