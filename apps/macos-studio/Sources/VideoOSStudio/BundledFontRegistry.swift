import CoreText
import Foundation
import VideoOSStudioCore

enum StudioBundledFontRegistry {
    static let fontID = "noto-sans-jp"
    static let family = "Noto Sans JP"
    static let boldFamily = "VideoOS Noto Sans JP Bold"
    static let heavyFamily = "VideoOS Noto Sans JP Black"

    static let registrationReport: CaptionFontRuntimeStatus = {
        let bundle = Bundle.module
        let specifications = [
            (role: "primary", family: family, resource: "NotoSansJP-Variable"),
            (role: "bold", family: boldFamily, resource: "VideoOSNotoSansJPBold"),
            (role: "heavy", family: heavyFamily, resource: "VideoOSNotoSansJPBlack"),
        ]
        let assets = specifications.map { specification in
            let fontURL = bundle.url(
                forResource: specification.resource,
                withExtension: "ttf",
                subdirectory: "Fonts"
            ) ?? bundle.url(
                forResource: specification.resource,
                withExtension: "ttf"
            )
            guard let fontURL else {
                return CaptionFontRuntimeStatus.Asset(
                    role: specification.role,
                    family: specification.family,
                    resource: specification.resource,
                    state: .blocked,
                    diagnostic: "missing_resource: \(specification.resource).ttf"
                )
            }

            var registrationError: Unmanaged<CFError>?
            if CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, &registrationError) {
                return CaptionFontRuntimeStatus.Asset(
                    role: specification.role,
                    family: specification.family,
                    resource: specification.resource,
                    state: .ready
                )
            }
            let detail = registrationError?.takeRetainedValue()
            let message = detail.map { CFErrorCopyDescription($0) as String }
                ?? "CoreText rejected \(specification.resource).ttf"
            return CaptionFontRuntimeStatus.Asset(
                role: specification.role,
                family: specification.family,
                resource: specification.resource,
                state: .blocked,
                diagnostic: "registration_failed: \(message)"
            )
        }
        return CaptionFontRuntimeStatus(assets: assets)
    }()

    static func register() {
        for asset in registrationReport.assets where asset.state == .blocked {
            fputs(
                "[VideoOSStudio] bundled font \(asset.role) blocked: \(asset.diagnostic ?? "unknown")\n",
                stderr
            )
        }
    }
}
