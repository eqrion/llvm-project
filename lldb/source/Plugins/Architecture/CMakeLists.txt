set_property(DIRECTORY PROPERTY LLDB_PLUGIN_KIND Architecture)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  add_subdirectory(Arm)
  add_subdirectory(Mips)
  add_subdirectory(PPC64)
  add_subdirectory(AArch64)
endif()
