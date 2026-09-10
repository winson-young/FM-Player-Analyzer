# Path to the legacy Python app: source of fixture data (definitions.json)
# and golden-master reference outputs.
set(LEGACY_DIR "${CMAKE_SOURCE_DIR}/../legacy")

function(fm_add_test name)
    add_executable(${name} ${name}.cpp)
    target_link_libraries(${name} PRIVATE fmcore Qt6::Test)
    target_compile_definitions(${name} PRIVATE LEGACY_DIR="${LEGACY_DIR}")
    add_test(NAME ${name} COMMAND ${name})
    # Qt DLLs are not on PATH on Windows; point the test at the Qt bin directory.
    set_tests_properties(${name} PROPERTIES
        ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:$<TARGET_FILE_DIR:Qt6::Core>"
    )
endfunction()

fm_add_test(test_smoke)
fm_add_test(test_utils)
fm_add_test(test_definitions)
fm_add_test(test_appconfig)
fm_add_test(test_playerstore)
fm_add_test(test_migrator)
fm_add_test(test_dwrs)
fm_add_test(test_htmlimporter)
fm_add_test(test_database)
fm_add_test(test_freshness)
fm_add_test(test_nationalcallup)
fm_add_test(test_trainingadvice)

# Translation catalogues. The check runs on node instead of Qt: it validates the
# zh_CN catalogue against the English one and round-trips the compiled .qm
# through QTranslator's lookup algorithm (hash table, context table, payload
# layout). Skipped when node is unavailable so the C++ suite still runs.
find_program(FM_NODE_EXECUTABLE NAMES node node.exe)
if(FM_NODE_EXECUTABLE)
    add_test(NAME test_translations
        COMMAND ${FM_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test_translations.mjs)
    set_tests_properties(test_translations PROPERTIES WORKING_DIRECTORY ${CMAKE_SOURCE_DIR})
else()
    message(STATUS "node not found - skipping the translation catalogue test.")
endif()
