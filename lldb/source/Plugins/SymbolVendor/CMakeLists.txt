set_property(DIRECTORY PROPERTY LLDB_PLUGIN_KIND SymbolVendor)
set_property(DIRECTORY PROPERTY LLDB_ACCEPTABLE_PLUGIN_DEPENDENCIES ObjectFile)

if(CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  add_subdirectory(wasm)
else()
  add_subdirectory(ELF)

  if (CMAKE_SYSTEM_NAME MATCHES "Darwin")
    add_subdirectory(MacOSX)
  endif()

  add_subdirectory(PECOFF)
  add_subdirectory(wasm)
endif()
