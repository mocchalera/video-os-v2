import Foundation

public struct FootageSearchRunner: Sendable {
    public struct SearchResult: Codable, Equatable, Identifiable, Sendable {
        public var id: String { segment_id }
        public let segment_id: String
        public let asset_id: String
        public let src_in_us: Int
        public let src_out_us: Int
        public let score: Double
        public let scores: [String: Double]?
        public let key_frame_path: String?
        public let tags: [String]?
        public let quality_flags: [String]?
        public let summary: String?

        enum CodingKeys: String, CodingKey {
            case segment_id
            case asset_id
            case src_in_us
            case src_out_us
            case score
            case scores
            case key_frame_path
            case tags
            case quality_flags
            case summary
        }

        public init(
            segment_id: String,
            asset_id: String,
            src_in_us: Int,
            src_out_us: Int,
            score: Double,
            scores: [String: Double]? = nil,
            key_frame_path: String? = nil,
            tags: [String]? = nil,
            quality_flags: [String]? = nil,
            summary: String? = nil
        ) {
            self.segment_id = segment_id
            self.asset_id = asset_id
            self.src_in_us = src_in_us
            self.src_out_us = src_out_us
            self.score = score
            self.scores = scores
            self.key_frame_path = key_frame_path
            self.tags = tags
            self.quality_flags = quality_flags
            self.summary = summary
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            segment_id = try container.decode(String.self, forKey: .segment_id)
            asset_id = try container.decode(String.self, forKey: .asset_id)
            src_in_us = try container.decode(Int.self, forKey: .src_in_us)
            src_out_us = try container.decode(Int.self, forKey: .src_out_us)
            score = try container.decode(Double.self, forKey: .score)
            scores = try Self.decodeNumericScores(from: container, forKey: .scores)
            key_frame_path = try container.decodeIfPresent(String.self, forKey: .key_frame_path)
            tags = try container.decodeIfPresent([String].self, forKey: .tags)
            quality_flags = try container.decodeIfPresent([String].self, forKey: .quality_flags)
            summary = try container.decodeIfPresent(String.self, forKey: .summary)
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(segment_id, forKey: .segment_id)
            try container.encode(asset_id, forKey: .asset_id)
            try container.encode(src_in_us, forKey: .src_in_us)
            try container.encode(src_out_us, forKey: .src_out_us)
            try container.encode(score, forKey: .score)
            try container.encodeIfPresent(scores, forKey: .scores)
            try container.encodeIfPresent(key_frame_path, forKey: .key_frame_path)
            try container.encodeIfPresent(tags, forKey: .tags)
            try container.encodeIfPresent(quality_flags, forKey: .quality_flags)
            try container.encodeIfPresent(summary, forKey: .summary)
        }

        private static func decodeNumericScores(
            from container: KeyedDecodingContainer<CodingKeys>,
            forKey key: CodingKeys
        ) throws -> [String: Double]? {
            guard container.contains(key) else { return nil }
            if (try? container.decodeNil(forKey: key)) == true { return nil }
            let nested = try container.nestedContainer(keyedBy: DynamicCodingKey.self, forKey: key)
            var result: [String: Double] = [:]
            for scoreKey in nested.allKeys {
                if let double = try? nested.decode(Double.self, forKey: scoreKey) {
                    result[scoreKey.stringValue] = double
                } else if let int = try? nested.decode(Int.self, forKey: scoreKey) {
                    result[scoreKey.stringValue] = Double(int)
                }
            }
            return result.isEmpty ? nil : result
        }
    }

    public struct SearchResponse: Codable, Equatable, Sendable {
        public let queryText: String?
        public let db_status: String?
        public let mode_used: String?
        public let results: [SearchResult]
        public let warnings: [String]?
        public let error: String?

        enum CodingKeys: String, CodingKey {
            case query
            case db_status
            case mode_used
            case results
            case warnings
            case error
        }

        public init(
            queryText: String?,
            db_status: String?,
            mode_used: String?,
            results: [SearchResult],
            warnings: [String]? = nil,
            error: String? = nil
        ) {
            self.queryText = queryText
            self.db_status = db_status
            self.mode_used = mode_used
            self.results = results
            self.warnings = warnings
            self.error = error
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            queryText = Self.decodeQueryText(from: container)
            db_status = try container.decodeIfPresent(String.self, forKey: .db_status)
            mode_used = try container.decodeIfPresent(String.self, forKey: .mode_used)
            results = try container.decodeIfPresent([SearchResult].self, forKey: .results) ?? []
            warnings = try container.decodeIfPresent([String].self, forKey: .warnings)
            error = try container.decodeIfPresent(String.self, forKey: .error)
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encodeIfPresent(queryText, forKey: .query)
            try container.encodeIfPresent(db_status, forKey: .db_status)
            try container.encodeIfPresent(mode_used, forKey: .mode_used)
            try container.encode(results, forKey: .results)
            try container.encodeIfPresent(warnings, forKey: .warnings)
            try container.encodeIfPresent(error, forKey: .error)
        }

        private static func decodeQueryText(from container: KeyedDecodingContainer<CodingKeys>) -> String? {
            if let string = try? container.decodeIfPresent(String.self, forKey: .query) {
                return string
            }
            if let object = try? container.nestedContainer(keyedBy: DynamicCodingKey.self, forKey: .query) {
                let queryKey = DynamicCodingKey(stringValue: "query")
                if let queryKey, let string = try? object.decodeIfPresent(String.self, forKey: queryKey) {
                    return string
                }
            }
            return nil
        }
    }

    public static func search(
        projectURL: URL,
        repositoryRoot: URL,
        mode: String,
        query: String?,
        imageQueryPath: String?,
        audioQueryPath: String?,
        limit: Int
    ) async -> SearchResponse {
        await Task.detached(priority: .userInitiated) {
            var arguments = [
                "npx",
                "tsx",
                "runtime/tools/footage-search-cli.ts",
                "--project",
                projectURL.path,
                "--mode",
                mode,
                "--limit",
                "\(max(1, limit))",
                "--json",
            ]
            if let query, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                arguments.append(contentsOf: ["--query", query])
            }
            if let imageQueryPath, !imageQueryPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                arguments.append(contentsOf: ["--image-query-path", imageQueryPath])
            }
            if let audioQueryPath, !audioQueryPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                arguments.append(contentsOf: ["--audio-query-path", audioQueryPath])
            }

            do {
                let output = try SubprocessRunner.run(arguments: arguments, currentDirectoryURL: repositoryRoot)
                guard output.exitCode == 0 else {
                    return SearchResponse(
                        queryText: query,
                        db_status: nil,
                        mode_used: mode,
                        results: [],
                        warnings: nil,
                        error: processFailureReason(output: output)
                    )
                }
                do {
                    return try JSONDecoder().decode(SearchResponse.self, from: Data(output.stdout.utf8))
                } catch {
                    return SearchResponse(
                        queryText: query,
                        db_status: nil,
                        mode_used: mode,
                        results: [],
                        warnings: nil,
                        error: "Invalid footage search JSON: \(error)"
                    )
                }
            } catch {
                return SearchResponse(
                    queryText: query,
                    db_status: nil,
                    mode_used: mode,
                    results: [],
                    warnings: nil,
                    error: "Footage search failed to run: \(error)"
                )
            }
        }.value
    }

    private static func processFailureReason(output: SubprocessRunner.Output) -> String {
        let diagnostic = firstNonEmptyDiagnostic(output.stderr, output.stdout)
        if let diagnostic {
            return "footage-search-cli exited with code \(output.exitCode): \(diagnostic)"
        }
        return "footage-search-cli exited with code \(output.exitCode)"
    }

    private static func firstNonEmptyDiagnostic(_ values: String...) -> String? {
        let diagnostic = values
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
        guard let diagnostic else { return nil }
        return diagnostic.count > 280 ? "\(diagnostic.prefix(280))..." : diagnostic
    }
}

private struct DynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = "\(intValue)"
        self.intValue = intValue
    }
}
