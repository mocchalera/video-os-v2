import Foundation

public struct ProjectThumbnailCache: Sendable {
    public static func thumbnailURL(
        projectURL: URL,
        assetID: String,
        keyFramePath: String? = nil,
        assets: AnalysisAssetDocument?
    ) -> URL? {
        if let keyFrame = existingKeyFrame(
            projectURL: projectURL,
            assetID: assetID,
            keyFramePath: keyFramePath,
            assets: assets
        ) {
            return keyFrame
        }
        if let representative = existingRepresentativeFrame(projectURL: projectURL, assetID: assetID, assets: assets) {
            return representative
        }
        if let poster = existingPoster(projectURL: projectURL, assetID: assetID, assets: assets) {
            return poster
        }
        return onDemandFallback(projectURL: projectURL, assetID: assetID, assets: assets)
    }

    private static func existingRepresentativeFrame(
        projectURL: URL,
        assetID: String,
        assets: AnalysisAssetDocument?
    ) -> URL? {
        let direct = projectURL.appendingPathComponent("03_analysis/frames/\(assetID)/representative.jpg")
        if FileManager.default.fileExists(atPath: direct.path) {
            return direct
        }

        let segmentIDs = assets?.items.first { $0.id == assetID }?.segmentIDs ?? []
        for segmentID in segmentIDs {
            let url = projectURL.appendingPathComponent("03_analysis/frames/\(segmentID)/representative.jpg")
            if FileManager.default.fileExists(atPath: url.path) {
                return url
            }
        }
        return nil
    }

    private static func existingPoster(projectURL: URL, assetID: String, assets: AnalysisAssetDocument?) -> URL? {
        guard let posterPath = assets?.items.first(where: { $0.id == assetID })?.posterPath else { return nil }
        let url = resolveArtifactPath(posterPath, projectURL: projectURL, defaultBase: "03_analysis")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private static func existingKeyFrame(
        projectURL: URL,
        assetID: String,
        keyFramePath: String?,
        assets: AnalysisAssetDocument?
    ) -> URL? {
        let paths = [
            keyFramePath,
            assets?.items.first(where: { $0.id == assetID })?.keyFramePath,
            keyFramePathFromVisualSearchTrace(projectURL: projectURL, assetID: assetID),
        ].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        var seen = Set<String>()
        for path in paths where seen.insert(path).inserted {
            if let url = existingArtifactPath(path, projectURL: projectURL, defaultBase: "03_analysis") {
                return url
            }
        }
        return nil
    }

    private static func onDemandFallback(projectURL: URL, assetID: String, assets: AnalysisAssetDocument?) -> URL? {
        guard let asset = assets?.items.first(where: { $0.id == assetID }) else { return nil }
        guard let cacheURL = cacheURL(projectURL: projectURL, assetID: assetID) else { return nil }
        if FileManager.default.fileExists(atPath: cacheURL.path) {
            return cacheURL
        }
        guard let sourceURL = sourceURL(projectURL: projectURL, asset: asset) else { return nil }

        do {
            try FileManager.default.createDirectory(
                at: cacheURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let output = try SubprocessRunner.run(
                arguments: [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-ss",
                    "0.5",
                    "-i",
                    sourceURL.path,
                    "-frames:v",
                    "1",
                    "-q:v",
                    "3",
                    cacheURL.path,
                ]
            )
            guard output.exitCode == 0, FileManager.default.fileExists(atPath: cacheURL.path) else {
                try? FileManager.default.removeItem(at: cacheURL)
                return nil
            }
            return cacheURL
        } catch {
            try? FileManager.default.removeItem(at: cacheURL)
            return nil
        }
    }

    private static func resolveArtifactPath(_ rawPath: String, projectURL: URL, defaultBase: String) -> URL {
        if rawPath.hasPrefix("/") {
            return URL(fileURLWithPath: rawPath)
        }
        if rawPath.hasPrefix("03_analysis/") || rawPath.hasPrefix("04_plan/") || rawPath.hasPrefix("02_media/") {
            return projectURL.appendingPathComponent(rawPath)
        }
        if defaultBase.isEmpty {
            return projectURL.appendingPathComponent(rawPath)
        }
        return projectURL.appendingPathComponent(defaultBase).appendingPathComponent(rawPath)
    }

    private static func existingArtifactPath(_ rawPath: String, projectURL: URL, defaultBase: String) -> URL? {
        let primary = resolveArtifactPath(rawPath, projectURL: projectURL, defaultBase: defaultBase)
        if FileManager.default.fileExists(atPath: primary.path) {
            return primary
        }

        guard !defaultBase.isEmpty else { return nil }
        let projectRelative = resolveArtifactPath(rawPath, projectURL: projectURL, defaultBase: "")
        return FileManager.default.fileExists(atPath: projectRelative.path) ? projectRelative : nil
    }

    private static func sourceURL(projectURL: URL, asset: AnalysisAsset) -> URL? {
        var candidates: [URL] = []
        if let sourceLocator = asset.sourceLocator {
            candidates.append(resolveArtifactPath(sourceLocator, projectURL: projectURL, defaultBase: ""))
        }
        candidates.append(projectURL.appendingPathComponent("02_media/source/\(asset.filename)"))
        candidates.append(projectURL.appendingPathComponent("02_media/\(asset.filename)"))
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private static func cacheURL(projectURL: URL, assetID: String) -> URL? {
        guard let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        let projectKey = ProjectPlaybackContractStatusReader.fileHash16(Data(projectURL.standardizedFileURL.path.utf8))
        return base
            .appendingPathComponent("VideoOSStudio/Thumbnails/\(projectKey)", isDirectory: true)
            .appendingPathComponent("\(assetID).jpg")
    }

    private static func keyFramePathFromVisualSearchTrace(projectURL: URL, assetID: String) -> String? {
        let traceURL = projectURL.appendingPathComponent("04_plan/visual_search_trace.json")
        guard
            let data = try? Data(contentsOf: traceURL),
            let root = try? JSONSerialization.jsonObject(with: data)
        else {
            return nil
        }
        return findKeyFramePath(in: root, assetID: assetID)
    }

    private static func findKeyFramePath(in value: Any, assetID: String) -> String? {
        if let dictionary = value as? [String: Any] {
            if dictionary["asset_id"] as? String == assetID {
                if let path = dictionary["key_frame_path"] as? String {
                    return path
                }
                if let path = dictionary["matched_frame_path"] as? String {
                    return path
                }
            }
            for child in dictionary.values {
                if let path = findKeyFramePath(in: child, assetID: assetID) {
                    return path
                }
            }
        } else if let array = value as? [Any] {
            for child in array {
                if let path = findKeyFramePath(in: child, assetID: assetID) {
                    return path
                }
            }
        }
        return nil
    }
}
