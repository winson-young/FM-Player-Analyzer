#include <QApplication>
#include <QFont>
#include <QFontDatabase>
#include <QIcon>
#include <QMessageBox>
#include <QTimer>
#include <QTranslator>

#include "AppContext.h"
#include "FirstRunDialog.h"
#include "MainWindow.h"
#include "theming/ThemeManager.h"
#include "core/Version.h"

namespace {

// UI languages the app ships. The source strings are German ("de" therefore
// needs no translator at all); every other language loads a compiled .qm from
// the embedded :/i18n resource.
struct LanguageOption {
    const char *code;
    const char *resource; // nullptr = untranslated German source strings
};

constexpr LanguageOption kLanguages[] = {
    {"en", ":/i18n/fmplayeranalyzer_en.qm"},
    {"de", nullptr},
    {"zh", ":/i18n/fmplayeranalyzer_zh_CN.qm"},
};

// Chinese (and the emoji/Qt UI glyphs around it) needs a font that actually
// covers CJK; Segoe UI does not. Font substitution would rescue individual
// missing glyphs, but only a real CJK family gives consistent metrics.
void applyCjkFontFallback(QFont &font, const QString &language)
{
    if (language != QLatin1String("zh"))
        return;
    const QStringList candidates{QStringLiteral("Microsoft YaHei UI"),
                                 QStringLiteral("Microsoft YaHei"),
                                 QStringLiteral("SimHei")};
    const QStringList installed = QFontDatabase::families();
    for (const QString &candidate : candidates) {
        if (installed.contains(candidate)) {
            font.setFamilies({font.family(), candidate});
            return;
        }
    }
}

} // namespace

int main(int argc, char *argv[])
{
    QApplication app(argc, argv);
    QApplication::setApplicationName(fm::appName());
    QApplication::setApplicationVersion(fm::appVersion());
    // Stable internal identifier — do NOT rename, or existing users lose their
    // data folder (%LOCALAPPDATA%\FM24PlayerAnalyzer). The visible app name
    // lives in Version::appName().
    QApplication::setOrganizationName(QStringLiteral("FM24PlayerAnalyzer"));
    QApplication::setWindowIcon(QIcon(QStringLiteral(":/app/favicon.ico")));

    fm::AppContext context;

    // Language must be installed before any widgets are built (including the
    // first-run dialog and the statically initialized navigation labels).
    // Default English via the bundled .qm; "de" keeps the German source text.
    const QString language = context.paths().language();
    QTranslator appTranslator;
    for (const LanguageOption &option : kLanguages) {
        if (language != QLatin1String(option.code) || !option.resource)
            continue;
        if (appTranslator.load(QString::fromLatin1(option.resource)))
            QApplication::installTranslator(&appTranslator);
        break;
    }

    QFont appFont(QStringLiteral("Segoe UI"), 10);
    appFont.setHintingPreference(QFont::PreferFullHinting);
    applyCjkFontFallback(appFont, language);
    app.setFont(appFont);

    if (context.paths().isFirstRun()) {
        fm::FirstRunDialog dialog(fm::AppPaths::defaultDataDir());
        if (dialog.exec() != QDialog::Accepted)
            return 0;
        context.paths().setDataDir(dialog.chosenDataDir());
    }

    QString error;
    if (!context.initialize(&error)) {
        QMessageBox::critical(nullptr, fm::appName(),
                              QObject::tr("Start fehlgeschlagen:\n%1").arg(error));
        return 1;
    }

    fm::ThemeManager theme(context.config());
    theme.apply();

    fm::MainWindow window(context, theme);
    window.show();

    // --smoke: exit immediately after the event loop starts (build verification)
    if (app.arguments().contains(QStringLiteral("--smoke"))) {
        QTimer::singleShot(0, &app, &QCoreApplication::quit);
    }

    return app.exec();
}
