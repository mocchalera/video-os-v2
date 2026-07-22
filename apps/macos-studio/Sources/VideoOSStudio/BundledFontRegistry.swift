import CoreText
import Foundation

enum StudioBundledFontRegistry {
    static let fontID = "noto-sans-jp"
    static let family = "Noto Sans JP"

    private static let registration: Result<Void, Error> = Result {
        let bundle = Bundle.module
        let fontURL = bundle.url(
            forResource: "NotoSansJP-Variable",
            withExtension: "ttf",
            subdirectory: "Fonts"
        ) ?? bundle.url(
            forResource: "NotoSansJP-Variable",
            withExtension: "ttf"
        )
        guard let fontURL else {
            throw BundledFontError.missingResource
        }

        var registrationError: Unmanaged<CFError>?
        guard CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, &registrationError) else {
            let detail = registrationError?.takeRetainedValue()
            throw BundledFontError.registrationFailed(detail)
        }
    }

    static func register() {
        if case let .failure(error) = registration {
            fputs("[VideoOSStudio] bundled font registration failed: \(error)\n", stderr)
        }
    }
}

private enum BundledFontError: LocalizedError {
    case missingResource
    case registrationFailed(CFError?)

    var errorDescription: String? {
        switch self {
        case .missingResource:
            return "NotoSansJP-Variable.ttf is missing from Bundle.module"
        case let .registrationFailed(error):
            return error.map { CFErrorCopyDescription($0) as String }
                ?? "CoreText rejected NotoSansJP-Variable.ttf"
        }
    }
}
