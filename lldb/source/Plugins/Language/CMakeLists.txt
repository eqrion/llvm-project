set_property(DIRECTORY PROPERTY LLDB_PLUGIN_KIND Language)
set_property(DIRECTORY PROPERTY LLDB_TOLERATED_PLUGIN_DEPENDENCIES
  LanguageRuntime
  TypeSystem
)

add_subdirectory(CPlusPlus)
add_subdirectory(ObjC)
if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  add_subdirectory(ObjCPlusPlus)
endif()
