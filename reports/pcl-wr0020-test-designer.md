# Source Bin collection order tests planned

## Findings

- `F-0019` needs test coverage at three levels: pure catalog/state ordering, lifecycle integration around rename/merge/delete, and a manual running-app check for Source Bin regressions.
- The unit test should cover deterministic order persistence and active collection validity without involving timeline artifacts.
- The integration test should cover rename and merge behavior because existing collection logic already normalizes names and merges membership/metadata.
- The manual check should stay explicit because Source Bin collection ordering is a visible editor workflow and must not regress filters, search, grouping, favorites, work bin, source monitor, quick insert, row/tile drag, or timeline state.

## Evidence

- `F-0019` was created for Source Bin collection order management.
- `US-0003` was drafted for persistent deliberate Source Bin collection order.
- `TC-0003` was planned as an integration test for reordered collection rename and merge behavior.
- `TC-0004` was planned as a manual running-app regression check for Source Bin and timeline side effects.
- `TC-0005` was planned as a unit test for collection order persistence and active collection validity.
- `ProjectMediaSourceBinCollectionCatalogTests` already covers collection normalize, rename, delete, metadata, and merge behavior and is the natural Swift test home for order helpers.

## Recommended pcl Commands

- `pcl test plan --feature F-0019 --story US-0003 --type unit --scenario "Create several Source Bin collections, reorder them through the collection catalog/state helper, and reload project-scoped state." --expected "The explicit order is preserved, the active collection remains valid, and membership/status/note data stays attached to the correct collection."`
- `pcl test plan --feature F-0019 --story US-0003 --type integration --scenario "Rename a reordered collection into a new name and then into an existing collection name that triggers merge behavior." --expected "The order remains deterministic, merged metadata/membership follow existing collection catalog rules, no duplicate collection names appear, and the active selection points at a surviving collection."`
- `pcl test plan --feature F-0019 --story US-0003 --type manual --scenario "In the running macOS app, reorder collections while Source Bin filters, search, grouping, favorites, work bin, source monitor selection, quick insert, row/tile drag, and timeline state are populated." --expected "Only collection display order changes. Timeline artifacts, review patch operations, compiler contracts, source monitor candidate state, favorites, work bin membership, and source insert/drop behavior remain unchanged."`
