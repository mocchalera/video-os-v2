import Foundation

public enum ProjectMediaSourceBinCollectionStatus: String, CaseIterable, Codable, Sendable {
    case candidate
    case reviewing
    case selected
    case hold
}

public struct ProjectMediaSourceBinCollectionMetadata: Equatable, Codable, Sendable {
    public static let maxNoteLength = 80

    public var status: ProjectMediaSourceBinCollectionStatus
    public var note: String

    public init(
        status: ProjectMediaSourceBinCollectionStatus = .candidate,
        note: String = ""
    ) {
        self.status = status
        self.note = Self.normalizedNote(note)
    }

    public init(statusRawValue: String?, note: String) {
        self.init(
            status: statusRawValue.flatMap(ProjectMediaSourceBinCollectionStatus.init(rawValue:)) ?? .candidate,
            note: note
        )
    }

    public static let empty = ProjectMediaSourceBinCollectionMetadata()

    public var isDefault: Bool {
        status == .candidate && note.isEmpty
    }

    public static func normalizedNote(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return String(trimmed.prefix(maxNoteLength))
    }
}

public enum ProjectMediaSourceBinCollectionMetadataCatalog {
    public static func metadata(
        for rawName: String,
        in metadataByName: [String: ProjectMediaSourceBinCollectionMetadata],
        defaultName: String = ProjectMediaSourceBinCollectionCatalog.defaultName
    ) -> ProjectMediaSourceBinCollectionMetadata {
        metadataByName[ProjectMediaSourceBinCollectionCatalog.normalizedName(rawName, defaultName: defaultName)]
            ?? .empty
    }

    public static func storing(
        _ metadata: ProjectMediaSourceBinCollectionMetadata,
        for rawName: String,
        in metadataByName: [String: ProjectMediaSourceBinCollectionMetadata],
        defaultName: String = ProjectMediaSourceBinCollectionCatalog.defaultName
    ) -> [String: ProjectMediaSourceBinCollectionMetadata] {
        let normalizedName = ProjectMediaSourceBinCollectionCatalog.normalizedName(rawName, defaultName: defaultName)
        let normalizedMetadata = ProjectMediaSourceBinCollectionMetadata(
            status: metadata.status,
            note: metadata.note
        )
        var updated = metadataByName
        if normalizedMetadata.isDefault {
            updated.removeValue(forKey: normalizedName)
        } else {
            updated[normalizedName] = normalizedMetadata
        }
        return updated
    }

    public static func renaming(
        _ oldName: String,
        to rawNewName: String,
        in metadataByName: [String: ProjectMediaSourceBinCollectionMetadata],
        defaultName: String = ProjectMediaSourceBinCollectionCatalog.defaultName
    ) -> [String: ProjectMediaSourceBinCollectionMetadata] {
        let normalizedOldName = ProjectMediaSourceBinCollectionCatalog.normalizedName(oldName, defaultName: defaultName)
        let normalizedNewName = ProjectMediaSourceBinCollectionCatalog.normalizedName(rawNewName, defaultName: defaultName)
        guard normalizedOldName != normalizedNewName else {
            return metadataByName
        }

        var updated = metadataByName
        guard let oldMetadata = updated.removeValue(forKey: normalizedOldName) else {
            return updated
        }

        let mergedMetadata = merging(oldMetadata, into: updated[normalizedNewName])
        if mergedMetadata.isDefault {
            updated.removeValue(forKey: normalizedNewName)
        } else {
            updated[normalizedNewName] = mergedMetadata
        }
        return updated
    }

    public static func deleting(
        _ rawName: String,
        in metadataByName: [String: ProjectMediaSourceBinCollectionMetadata],
        defaultName: String = ProjectMediaSourceBinCollectionCatalog.defaultName
    ) -> [String: ProjectMediaSourceBinCollectionMetadata] {
        let normalizedName = ProjectMediaSourceBinCollectionCatalog.normalizedName(rawName, defaultName: defaultName)
        var updated = metadataByName
        updated.removeValue(forKey: normalizedName)
        return updated
    }

    private static func merging(
        _ source: ProjectMediaSourceBinCollectionMetadata,
        into destination: ProjectMediaSourceBinCollectionMetadata?
    ) -> ProjectMediaSourceBinCollectionMetadata {
        guard var destination else {
            return ProjectMediaSourceBinCollectionMetadata(status: source.status, note: source.note)
        }
        if destination.status == .candidate {
            destination.status = source.status
        }
        if destination.note.isEmpty {
            destination.note = source.note
        }
        return ProjectMediaSourceBinCollectionMetadata(status: destination.status, note: destination.note)
    }
}

public enum ProjectMediaSourceBinCollectionCatalog {
    public static let defaultName = "選別A"

    public static func normalizedName(_ rawValue: String, defaultName: String = Self.defaultName) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? defaultName : String(trimmed.prefix(24))
    }

    public static func names(
        storedNames: some Sequence<String>,
        activeName: String,
        preferredOrder: [String] = [],
        defaultName: String = Self.defaultName
    ) -> [String] {
        var names = Set(storedNames.map { normalizedName($0, defaultName: defaultName) })
        names.insert(normalizedName(activeName, defaultName: defaultName))
        let sortedNames = names.sorted { lhs, rhs in
            let comparison = lhs.compare(
                rhs,
                options: [.caseInsensitive, .numeric],
                range: nil,
                locale: Locale(identifier: "ja_JP")
            )
            if comparison == .orderedSame {
                return lhs < rhs
            }
            return comparison == .orderedAscending
        }
        var seen: Set<String> = []
        var orderedNames: [String] = []
        for rawName in preferredOrder {
            let name = normalizedName(rawName, defaultName: defaultName)
            guard names.contains(name), !seen.contains(name) else { continue }
            orderedNames.append(name)
            seen.insert(name)
        }
        orderedNames.append(contentsOf: sortedNames.filter { !seen.contains($0) })
        return orderedNames
    }

    public static func moving(
        _ rawName: String,
        by offset: Int,
        in names: [String],
        defaultName: String = Self.defaultName
    ) -> [String] {
        guard offset != 0 else { return names }
        let normalizedTarget = normalizedName(rawName, defaultName: defaultName)
        var normalizedNames: [String] = []
        var seen: Set<String> = []
        for rawName in names {
            let name = normalizedName(rawName, defaultName: defaultName)
            guard !seen.contains(name) else { continue }
            normalizedNames.append(name)
            seen.insert(name)
        }
        guard let currentIndex = normalizedNames.firstIndex(of: normalizedTarget) else {
            return normalizedNames
        }
        let targetIndex = max(0, min(normalizedNames.count - 1, currentIndex + offset))
        guard currentIndex != targetIndex else {
            return normalizedNames
        }
        let moved = normalizedNames.remove(at: currentIndex)
        normalizedNames.insert(moved, at: targetIndex)
        return normalizedNames
    }

    public static func renamingOrder(
        _ oldName: String,
        to rawNewName: String,
        in orderedNames: [String],
        defaultName: String = Self.defaultName
    ) -> [String] {
        let normalizedOldName = normalizedName(oldName, defaultName: defaultName)
        let normalizedNewName = normalizedName(rawNewName, defaultName: defaultName)
        guard normalizedOldName != normalizedNewName else {
            return names(storedNames: orderedNames, activeName: normalizedNewName, preferredOrder: orderedNames, defaultName: defaultName)
        }
        let hasDestination = orderedNames
            .map { normalizedName($0, defaultName: defaultName) }
            .contains(normalizedNewName)
        var updated: [String] = []
        var seen: Set<String> = []
        for rawName in orderedNames {
            let name = normalizedName(rawName, defaultName: defaultName)
            let nextName = name == normalizedOldName && !hasDestination ? normalizedNewName : name
            guard nextName != normalizedOldName, !seen.contains(nextName) else { continue }
            updated.append(nextName)
            seen.insert(nextName)
        }
        if !seen.contains(normalizedNewName) {
            updated.append(normalizedNewName)
        }
        return updated
    }

    public static func deletingOrder(
        _ rawName: String,
        in orderedNames: [String],
        defaultName: String = Self.defaultName
    ) -> [String] {
        let normalizedDeletedName = normalizedName(rawName, defaultName: defaultName)
        var updated: [String] = []
        var seen: Set<String> = []
        for rawName in orderedNames {
            let name = normalizedName(rawName, defaultName: defaultName)
            guard name != normalizedDeletedName, !seen.contains(name) else { continue }
            updated.append(name)
            seen.insert(name)
        }
        return updated
    }

    public static func nextName(
        existingNames: some Sequence<String>,
        defaultName: String = Self.defaultName
    ) -> String {
        let existing = Set(existingNames.map { normalizedName($0, defaultName: defaultName) })
        if !existing.contains(defaultName) {
            return defaultName
        }

        for scalar in UnicodeScalar("B").value...UnicodeScalar("Z").value {
            guard let suffix = UnicodeScalar(scalar) else { continue }
            let candidate = "選別\(String(suffix))"
            if !existing.contains(candidate) {
                return candidate
            }
        }

        var index = 2
        while true {
            let candidate = "選別\(index)"
            if !existing.contains(candidate) {
                return candidate
            }
            index += 1
        }
    }

    public static func renaming(
        _ oldName: String,
        to rawNewName: String,
        in collections: [String: Set<String>],
        defaultName: String = Self.defaultName
    ) -> [String: Set<String>] {
        let normalizedOldName = normalizedName(oldName, defaultName: defaultName)
        let normalizedNewName = normalizedName(rawNewName, defaultName: defaultName)
        guard normalizedOldName != normalizedNewName,
              let oldAssetIDs = collections[normalizedOldName]
        else {
            return collections
        }

        var updated = collections
        updated.removeValue(forKey: normalizedOldName)
        updated[normalizedNewName] = (updated[normalizedNewName] ?? []).union(oldAssetIDs)
        return updated
    }

    public static func adding(
        _ assetIDs: some Sequence<String>,
        to rawName: String,
        in collections: [String: Set<String>],
        defaultName: String = Self.defaultName
    ) -> [String: Set<String>] {
        let normalizedName = normalizedName(rawName, defaultName: defaultName)
        let normalizedAssetIDs = Set(assetIDs.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })
        var updated = collections
        updated[normalizedName] = (updated[normalizedName] ?? []).union(normalizedAssetIDs)
        return updated
    }

    public static func removing(
        _ assetIDs: some Sequence<String>,
        from rawName: String,
        in collections: [String: Set<String>],
        defaultName: String = Self.defaultName
    ) -> [String: Set<String>] {
        let normalizedName = normalizedName(rawName, defaultName: defaultName)
        let normalizedAssetIDs = Set(assetIDs.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })
        var updated = collections
        updated[normalizedName] = (updated[normalizedName] ?? []).subtracting(normalizedAssetIDs)
        return updated
    }
}
