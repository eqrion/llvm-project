set_property(DIRECTORY PROPERTY LLDB_PLUGIN_KIND UnwindAssembly)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  add_subdirectory(InstEmulation)
  add_subdirectory(x86)
endif()
