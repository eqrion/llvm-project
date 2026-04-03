if(CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  set(expression_parser_jit_components "")
else()
  set(expression_parser_jit_components ExecutionEngine MCJIT)
endif()

add_lldb_library(lldbPluginExpressionParserClang
  ASTResultSynthesizer.cpp
  ASTStructExtractor.cpp
  ASTUtils.cpp
  ClangASTImporter.cpp
  ClangASTMetadata.cpp
  ClangASTSource.cpp
  ClangExpressionDeclMap.cpp
  ClangExpressionHelper.cpp
  ClangExpressionParser.cpp
  ClangExpressionSourceCode.cpp
  ClangExpressionUtil.cpp
  ClangExpressionVariable.cpp
  ClangExternalASTSourceCallbacks.cpp
  ClangFunctionCaller.cpp
  ClangHost.cpp
  ClangModulesDeclVendor.cpp
  ClangPersistentVariables.cpp
  ClangUserExpression.cpp
  ClangUtil.cpp
  ClangUtilityFunction.cpp
  CppModuleConfiguration.cpp
  CxxModuleHandler.cpp
  IRDynamicChecks.cpp
  IRForTarget.cpp
  InjectPointerSigningFixups.cpp
  NameSearchContext.cpp

  DEPENDS
  intrinsics_gen

  LINK_COMPONENTS
    Core
    ${expression_parser_jit_components}
    ipo
    Support
    TargetParser
  LINK_LIBS
    lldbCore
    lldbExpression
    lldbHost
    lldbInterpreter
    lldbSymbol
    lldbTarget
    lldbUtility
    lldbValueObject
    lldbPluginCPlusPlusLanguage
    lldbPluginObjCRuntime
    lldbPluginTypeSystemClang
  CLANG_LIBS
    clangAST
    clangCodeGen
    clangEdit
    clangFrontend
    clangLex
    clangOptions
    clangParse
    clangRewrite
    clangRewriteFrontend
    clangSema
    clangSerialization
  )
