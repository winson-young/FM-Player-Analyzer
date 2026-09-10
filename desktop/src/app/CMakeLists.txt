add_executable(fmplayeranalyzer WIN32
    app.rc
    main.cpp
    AppContext.h
    AppContext.cpp
    AppPaths.h
    AppPaths.cpp
    FirstRunDialog.h
    FirstRunDialog.cpp
    MainWindow.h
    MainWindow.cpp
    MigrationWizard.h
    MigrationWizard.cpp
    ImportRunner.h
    ImportRunner.cpp
    PlayerActions.h
    PlayerActions.cpp
    RecalcHelper.h
    RecalcHelper.cpp
    pages/AssignRolesPage.h
    pages/AssignRolesPage.cpp
    pages/BestXiPage.h
    pages/BestXiPage.cpp
    pages/DashboardPage.h
    pages/DashboardPage.cpp
    pages/DwrsProgressPage.h
    pages/DwrsProgressPage.cpp
    pages/EditPlayerPage.h
    pages/EditPlayerPage.cpp
    pages/GapAnalysisPage.h
    pages/GapAnalysisPage.cpp
    pages/NationalBestXiPage.h
    pages/NationalBestXiPage.cpp
    pages/NationalCallupPage.h
    pages/NationalCallupPage.cpp
    pages/TrainingPlanPage.h
    pages/TrainingPlanPage.cpp
    pages/NationalDashboardPage.h
    pages/NationalDashboardPage.cpp
    pages/NationalSquadMatrixPage.h
    pages/NationalSquadMatrixPage.cpp
    pages/NationalSquadSelectionPage.h
    pages/NationalSquadSelectionPage.cpp
    pages/NewRolePage.h
    pages/NewRolePage.cpp
    pages/NewTacticPage.h
    pages/NewTacticPage.cpp
    pages/PageBase.h
    pages/PageHelpers.h
    pages/PlaceholderPage.h
    pages/PlayerComparisonPage.h
    pages/PlayerComparisonPage.cpp
    pages/PlayerProfilePage.h
    pages/PlayerProfilePage.cpp
    pages/RoleAnalysisPage.h
    pages/RoleAnalysisPage.cpp
    pages/SettingsPage.h
    pages/SettingsPage.cpp
    pages/SquadMatrixPage.h
    pages/SquadMatrixPage.cpp
    pages/TacticExplorerPage.h
    pages/TacticExplorerPage.cpp
    pages/TransfersPage.h
    pages/TransfersPage.cpp
    theming/ThemeManager.h
    theming/ThemeManager.cpp
    theming/ThemePresets.h
    theming/ThemePresets.cpp
    widgets/CellStyleDelegate.h
    widgets/CellStyleDelegate.cpp
    widgets/NumericTableItem.h
    widgets/PlayerSearchModel.h
    widgets/Charts.h
    widgets/Charts.cpp
    widgets/PersonalityFilterWidget.h
    widgets/PersonalityFilterWidget.cpp
    widgets/PlayerTableModel.h
    widgets/PlayerTableModel.cpp
    widgets/StrengthGridWidget.h
    widgets/StrengthGridWidget.cpp
    widgets/TacticPitchWidget.h
    widgets/TacticPitchWidget.cpp
    resources/app.qrc
)

target_include_directories(fmplayeranalyzer PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

target_link_libraries(fmplayeranalyzer PRIVATE
    fmcore
    Qt6::Widgets
    Qt6::Charts
)

# --- Translations -----------------------------------------------------------
# The source strings are German; English and Chinese are shipped as compiled
# .qm files loaded by language code (see main.cpp). "de" needs no .qm at all
# because the untranslated source strings already are German.
#
# lrelease compiles the hand-maintained .ts files when Qt's LinguistTools are
# present; otherwise the deterministic compiler in tools/build-qm.mjs does it,
# so a checkout without a Qt installation still builds. Regenerate the .ts files
# after adding tr() strings:
#   lupdate src -ts translations/fmplayeranalyzer_en.ts -no-obsolete
#   node tools/build-ts.mjs            # Chinese catalogue from tools/zh-CN-map.mjs
if(TARGET Qt6::lrelease)
    set(FM_LRELEASE_COMMAND Qt6::lrelease)
    set(FM_QM_TOOL "")
else()
    find_program(FM_NODE_EXECUTABLE NAMES node node.exe)
    if(NOT FM_NODE_EXECUTABLE)
        message(FATAL_ERROR "Neither Qt6::lrelease nor node was found - cannot compile the translations.")
    endif()
    set(FM_QM_TOOL ${CMAKE_SOURCE_DIR}/tools/build-qm.mjs)
    set(FM_LRELEASE_COMMAND ${FM_NODE_EXECUTABLE} ${FM_QM_TOOL})
endif()

set(FM_TRANSLATIONS
    en:${CMAKE_SOURCE_DIR}/translations/fmplayeranalyzer_en.ts
    zh_CN:${CMAKE_SOURCE_DIR}/translations/fmplayeranalyzer_zh_CN.ts
)
set(FM_QM_FILES "")
foreach(FM_ENTRY IN LISTS FM_TRANSLATIONS)
    string(REPLACE ":" ";" FM_ENTRY_PARTS "${FM_ENTRY}")
    list(GET FM_ENTRY_PARTS 0 FM_LANGUAGE)
    list(GET FM_ENTRY_PARTS 1 FM_TS_FILE)
    set(FM_QM_FILE ${CMAKE_CURRENT_BINARY_DIR}/fmplayeranalyzer_${FM_LANGUAGE}.qm)
    add_custom_command(
        OUTPUT ${FM_QM_FILE}
        COMMAND ${FM_LRELEASE_COMMAND} ${FM_TS_FILE} -qm ${FM_QM_FILE}
        DEPENDS ${FM_TS_FILE} ${FM_QM_TOOL}
        VERBATIM
        COMMENT "Compiling ${FM_LANGUAGE} translation"
    )
    set_source_files_properties(${FM_QM_FILE} PROPERTIES
        QT_RESOURCE_ALIAS fmplayeranalyzer_${FM_LANGUAGE}.qm)
    list(APPEND FM_QM_FILES ${FM_QM_FILE})
endforeach()
qt_add_resources(fmplayeranalyzer "translations"
    PREFIX "/i18n"
    FILES ${FM_QM_FILES}
)
