# XSLT Studio

Transform XML with XSLT and validate UBL 2.1 documents — XSD, EN16931, Peppol BIS 3.0, and optional Helger online validation. Everything is bundled; the only external requirement is Java.

[![Ko-fi](https://img.shields.io/badge/Support%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/andreivasilcin)

## Features

- **XSLT 2.0 transform** via bundled Saxon HE 10.9 — no Saxon install required
- **File picker** with RECENT and OPEN TABS sections; remembers last-used files
- **`<?xml-stylesheet?>`** processing instruction detection — pre-selects the referenced XSLT
- **XSLT parameter prompting** — scans `<xsl:param>` declarations before each run
- **UBL 2.1 XSD validation** — bundled schemas for 65+ document types
- **EN16931 Schematron rules** — bundled, European e-invoicing standard
- **Peppol BIS 3.0 rules** — bundled (current: 2025.11.0)
- **Helger online validation** — optional SOAP call; auto-detects VESID from `CustomizationID`
- **Trace-linked diagnostics** — validation errors link back to the producing XSLT line
- **Transform scenarios** — save named XML + XSLT + parameter combinations, run via QuickPick
- **Watch mode** — re-runs last transform automatically when source files are saved
- **AI fix** — send diagnostics to an LLM, apply fix as an undoable editor change
- **Keyboard shortcuts** — `Ctrl+Shift+T` / `Cmd+Shift+T` for transform, `Ctrl+Shift+V` / `Cmd+Shift+V` for validate

## Requirements

- **Java 8+** — the only external dependency; everything else is bundled
- VS Code 1.85.0+

The extension shows a one-time warning at startup if Java is not found on `PATH`.

## Quick Start

### Install Java

**macOS:** `brew install openjdk`

**Windows (PowerShell as Admin):** `winget install EclipseAdoptium.Temurin.21.JRE`

**Ubuntu/Debian:** `sudo apt install default-jre`

Verify: `java -version` — any version 8+ works.

### Run your first transform

1. Open an XML file
2. Press `Ctrl+Shift+T` (or click ⚡ in the editor title bar)
3. Select your XSLT stylesheet
4. The output opens beside the editor; validation runs automatically if the output is a UBL document

## Commands

| Command | Description |
|---|---|
| `XSLT Studio: Transform XML with XSLT` | Run XSLT transform with file picker |
| `XSLT Studio: Validate UBL Document` | Full validation (XSD + Schematron + Helger if enabled) |
| `XSLT Studio: Validate XSD Only` | XSD schema validation only |
| `XSLT Studio: Validate Business Rules Only` | EN16931 + Peppol Schematron rules only |
| `XSLT Studio: Run Scenario` | Pick and run a saved scenario |
| `XSLT Studio: Save Current Transform as Scenario` | Save last transform as a named scenario |
| `XSLT Studio: Manage Scenarios` | Open `xslt-scenarios.json` in editor |
| `XSLT Studio: Toggle Watch Mode` | Auto-re-run on save (status bar toggle) |
| `XSLT Studio: Fix All Errors with AI` | Send diagnostics to LLM, apply fix |
| `XSLT Studio: Set AI API Key` | Store API key for selected AI provider |

## Settings

| Setting | Default | Description |
|---|---|---|
| `xmlXslt.transform.outputDestination` | `newTab` | Open result in new tab or save to file |
| `xmlXslt.transform.defaultOutputExtension` | `xml` | Extension for saved output files |
| `xmlXslt.transform.enableTracing` | `true` | Saxon trace for XSLT source links in diagnostics |
| `xmlXslt.validation.enableAutoValidate` | `true` | Auto-validate UBL output after transform |
| `xmlXslt.validation.enableHelger` | `false` | Send to Helger online validation service |
| `xmlXslt.validation.helgerEndpoint` | `https://peppol.helger.com/wsdvs` | Helger SOAP endpoint |
| `xmlXslt.validation.helgerVesidVersion` | `latest` | Peppol version: `latest` (2025.11.0), `previous` (2025.5.0) |
| `xmlXslt.validation.helgerTimeoutMs` | `15000` | Helger SOAP request timeout (ms) |
| `xmlXslt.validation.enableSchematronEN16931` | `true` | Run EN16931 rules |
| `xmlXslt.validation.enableSchematronPeppol` | `true` | Run Peppol BIS 3.0 rules |
| `xmlXslt.ai.provider` | `anthropic` | AI provider: `anthropic`, `vertex`, `openai`, `gemini`, `groq` |
| `xmlXslt.ai.model` | _(empty)_ | Model ID; empty = provider default |
| `xmlXslt.ai.vertexProject` | _(empty)_ | GCP project ID (required for `vertex` provider) |
| `xmlXslt.ai.vertexRegion` | `us-east5` | GCP region for Vertex AI |
| `xmlXslt.ai.maxRetries` | `3` | AI fix retry attempts |

## AI Fix — Vertex AI Setup

Set `xmlXslt.ai.provider` to `vertex`. No API key is required — the extension uses [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials). Run `gcloud auth application-default login` once if not already configured.

Also set `xmlXslt.ai.vertexProject` to your GCP project ID and optionally `xmlXslt.ai.vertexRegion`.

## Bundled Components

| Component | Version | License |
|---|---|---|
| Saxon HE | 10.9 | MPL-2.0 |
| UBL 2.1 XSD schemas | 2.1 | OASIS IPR Policy |
| EN16931 Schematron rules | — | EUPL-1.2 |
| Peppol BIS 3.0 rules | 2025.11.0 | MPL-2.0 |

## Support & Contributing

- Issues: [GitHub](https://github.com/andrei191999/xml-xslt-studio/issues)
- Support development: [Ko-fi](https://ko-fi.com/andreivasilcin)

## License

MIT — Copyright (c) 2025 Andrei Vasilcin
