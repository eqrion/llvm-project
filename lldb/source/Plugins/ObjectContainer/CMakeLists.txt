set_property(DIRECTORY PROPERTY LLDB_PLUGIN_KIND ObjectContainer)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  add_subdirectory(BSD-Archive)
  add_subdirectory(Big-Archive)
  add_subdirectory(Universal-Mach-O)
  add_subdirectory(Mach-O-Fileset)
endif()
