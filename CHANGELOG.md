# Changelog

## [0.2.0] — 2026-04-23

### Added

- **PHIVE validation**: validates transform output using helger/phive with 40 bundled Maven JARs. Supports EN16931, Peppol BIS 3.0, and other profiles. Full SVRL result set with per-rule pass/fail.
- **Curated feed + ZIP-bundle model**: PHIVE stacks are distributed as signed GitHub release ZIPs. `Check for PHIVE rule updates` command checks the curated feed and installs atomically. Configurable via `xmlXslt.phive.feedUrl` and `xmlXslt.phive.checkIntervalDays` settings.
- **WebView panel**: live results panel showing transform output, validation issues, Phive status, and param controls side-by-side with the editor.
- **Parameter automation**: auto-populate XSLT params from XPath expressions against the source XML, environment variables, or regex capture groups — evaluated before each transform.
- **Param profiles**: save and restore named parameter sets per XSLT file. Profile dropdown groups profiles by current vs other stylesheets; cross-XSL profile switching changes the active stylesheet.
- **Scenario params**: transform scenarios now persist and restore `parameters` and `automations` in `.vscode/xslt-scenarios.json`.
- **Smart output column**: transform output opens in `xslt-studio-output.xml` (named untitled) in the column adjacent to the panel, reusing the tab if already open.
- **Two-row error entries**: validation issues in the panel show as two-row entries — source/line/code header row + message row. XML line and XSLT trace line are clickable links that navigate to the exact location.
- **Re-validate button**: re-run validation against the last transform output without re-transforming.
- **Saxon tracer** (`saxonTracer.ts`): captures XSLT instruction-level trace for more precise line mapping in error entries.
- **Report Bug link**: footer link opens the GitHub issue tracker.
- **`src/ui/editorPlacement.ts`**: shared helper for smart editor column placement and named untitled output target — used by transform, validate, watch, and scenario flows.

### Changed

- **PHIVE runtime**: migrated from Maven-based installs to signed GitHub release ZIP bundles. `PhiveRunner.java` replaces the old `XsdValidator.java` as the Java entry point.
- **`ValidationProfile`**: now a typed `as const` union (`types.ts`) instead of a loose string.
- **XSLT param cache**: `buildParamEntries()` uses an mtime-keyed cache (`_paramNameCache`) to avoid redundant file reads across operation cycles.
- **Single XSLT read per operation**: `promptForParameters` and `detectCustomizationId` accept an optional `xsltContent?` parameter; callers read the file once and pass content to both.
- **Panel reveal**: no longer forces `ViewColumn.Beside` — preserves the panel's current position on re-reveal.
- **Tab buttons**: full-width grid layout, larger touch targets, clearer active state.
- **Lock params**: checkbox replaced with 🔒/🔓 icon button.

### Security

- ZIP bomb protection: 200 MB total uncompressed cap, 50 MB per-entry cap, central/local header cross-validation.
- Path traversal and Windows ADS rejection in ZIP extraction; partial extraction cleaned up on failure.
- Atomic PHIVE installs: manifest written into staging before directory rename; previous stack restored on activation failure.
- Concurrency guard prevents simultaneous PHIVE installs.
- 30-second health-check timeout on PHIVE daemon startup.
- Single network retry with transient-error detection for PHIVE bundle downloads.
- Semver-aware prerelease version comparison for feed candidate selection.
- Canonical, deterministic feed ordering validated on load.

### Removed

- `XsdValidator.java` — replaced by `PhiveRunner.java`.
- `codeActionProvider.ts`, `missingElementSuggester.ts`, `xsltAnalyzer.ts` — old analysis modules.
- `contextBuilder.ts`, `fixAgent.ts`, `settingsManager.ts` — old AI fix modules.
- `initConfigCommand.ts`, `previewCommand.ts`, `showMappingCommand.ts` — unused commands.
- `mappingPanel.ts` — replaced by `panelManager.ts` + `panel.ts`.
- `watchManager.ts` — watch logic moved inline.
- Bundled Peppol Schematron XSLTs — superseded by PHIVE validation.

---

## [0.1.0] — 2026-04-11

### Added

- **XSLT transform**: run any XSLT 2.0 stylesheet against an XML file via Saxon HE 10.9 (bundled). Automatically detects `<?xml-stylesheet?>` processing instructions to pre-select the stylesheet.
- **File picker**: QuickPick with RECENT and OPEN TABS sections for both XML and XSLT files. Remembers last-used files across sessions.
- **XSLT parameter prompting**: scans `<xsl:param>` declarations in the stylesheet and prompts for values before each transform.
- **UBL 2.1 XSD validation**: validates transform output against bundled UBL 2.1 XSD schemas (Invoice, CreditNote, and 60+ other document types). Java-based validator, no external dependency.
- **EN16931 Schematron validation**: validates transform output against bundled EN16931 business rules (CEN/TC 434).
- **Peppol BIS 3.0 Schematron validation**: validates transform output against bundled Peppol BIS 3.0 rules (2025.11.0).
- **Helger online validation**: optional SOAP call to `peppol.helger.com` for authoritative Peppol validation. Auto-detects VESID from `CustomizationID`; falls back to QuickPick if detection fails.
- **Diagnostics with trace links**: validation errors appear in the Problems panel with Related Information links pointing to the corresponding XSLT source line.
- **Three validate-only commands**: full validation, XSD only, or business rules only — without running a transform.
- **Transform scenarios**: save named transform configurations (XML + XSLT + parameters) to `.vscode/xslt-scenarios.json` and re-run them via QuickPick.
- **Watch mode**: automatically re-runs the last transform when the source XML or XSLT file is saved. Toggle via status bar or command palette.
- **AI fix (Fix All Errors)**: sends all diagnostics + XSLT content to an LLM, applies the proposed fix as a reversible `WorkspaceEdit`. Supports Anthropic, Vertex AI (ADC-based), OpenAI, Gemini, and Groq.
- **AI fix (Fix This Error)**: per-diagnostic Quick Fix code action — right-click any `[Local-XSD]`, `[Local-SCH]`, or `[Helger]` error in the Problems panel.
- **Status bar**: shows issue count after each transform; watch mode toggle (ON/OFF).
- **Keyboard shortcuts**: `Ctrl+Shift+T` (transform) and `Ctrl+Shift+V` (validate) when an XML or XSL file is active.
