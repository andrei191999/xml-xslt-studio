# XSLT Transformer & UBL Validator

A powerful VS Code extension for XML transformation and UBL 2.1 document validation with comprehensive business rules support.

[![Ko-fi](https://img.shields.io/badge/Support%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/andreivasilcin)

## Features

### XSLT Transformation with Auto-Validation
- **One-Click Transformation**: Click the transform button in the editor title bar
- **Easy File Selection**: Popup dialogs to select your XML and XSLT files
- **Flexible Output**: View results in editor or save to file
- **XSLT 1.0 & 2.0 Support**: Uses bundled Saxon-HE (XSLT 2.0); falls back to system `xsltproc` when available
- **Auto-Validation**: When transform output is a UBL document, XSD + business rules validation runs automatically
- **XSLT Error Tracing**: Validation errors in the output link back to the exact line in your XSLT stylesheet that produces the problematic element (visible as "Related Information" in the Problems panel)
- **Missing Element Quick Fix**: Quick Fix suggestions on missing-element diagnostics to jump to the relevant XSLT template

### UBL 2.1 Document Validation
- **XSD Schema Validation**: Validates against official OASIS UBL 2.1 schemas for all 65+ document types (Invoice, CreditNote, Order, etc.)
- **EN16931 Business Rules**: European e-invoicing standard compliance (for Invoice and CreditNote)
- **Peppol BIS 3.0 Rules**: OpenPEPPOL billing specification validation
- **Inline Diagnostics**: Errors and warnings appear directly on the problematic lines in VS Code's Problems panel
- **Smart XPath Resolution**: Precise line number mapping from Schematron validation results
- **Element-Level Error Mapping**: Validation errors are placed on the specific element in the output, not just the root tag

## Usage

### XSLT Transformation
1. Click the transform button in the editor title bar
2. Select your input XML file
3. Select your XSLT stylesheet
4. Choose to view result in editor or save to file
5. If the output is a UBL document, validation runs automatically and errors appear in the Problems panel with links back to your XSLT source

Or use Command Palette (`Cmd+Shift+P`): **"XSLT: Transform XML"**

### UBL Validation
1. Open a UBL 2.1 XML document (Invoice, CreditNote, Order, etc.)
2. Click the validate button in the editor title bar or press `Cmd+Shift+V` (Mac) / `Ctrl+Shift+V` (Windows/Linux)
3. View validation results in the Problems panel

**Commands:**
- **UBL: Validate Document** - Full validation (XSD + EN16931 + Peppol)
- **UBL: Validate XSD Only** - Schema validation only
- **UBL: Validate Business Rules Only** - EN16931 + Peppol rules only

## Quick Start

### Step 1: Install Java (the only prerequisite)

**macOS:**
```bash
brew install openjdk
```

**Ubuntu / Debian:**
```bash
sudo apt update && sudo apt install default-jre -y
```

**Fedora / RHEL:**
```bash
sudo dnf install java-17-openjdk -y
```

**Windows (PowerShell as Admin):**
```powershell
winget install EclipseAdoptium.Temurin.21.JRE
```
Or download the installer from [adoptium.net](https://adoptium.net/).

**Verify it works:**
```bash
java -version
```
You should see output like `openjdk version "17.0.x"` or similar. Any version 8+ works.

### Step 2: Install the Extension

Search for **"UBL Validator"** in VS Code Extensions (`Cmd+Shift+X` / `Ctrl+Shift+X`) and click Install. That's it — everything else is bundled.

### Step 3: Use It

- **Transform XML**: `Cmd+Shift+P` > **XSLT: Transform XML**
- **Validate UBL**: Open an XML file and press `Cmd+Shift+V` (Mac) / `Ctrl+Shift+V` (Windows/Linux)

## Requirements

### System Dependencies
- **VS Code**: 1.74.0 or higher
- **Java**: 8 or higher — see [Quick Start](#quick-start) above for install commands

The extension will show a warning on startup if Java is not detected.

### Optional Tools (used automatically when available)
These are **not required** — the extension works without them. When present, they're used as faster alternatives:
- **xsltproc**: For XSLT 1.0 transforms (pre-installed on macOS/Linux)
- **xmllint**: For XSD validation (pre-installed on macOS/Linux)

### Bundled Components
The extension bundles everything else it needs — no extra downloads:
- **Saxon-HE 10.9**: XSLT 2.0 processor (MPL-2.0 license)
- **XSD Validator**: Built-in Java XSD validator
- **UBL 2.1 XSD schemas** (OASIS) - All 65+ document types
- **EN16931 validation rules** (European Commission, EUPL-1.2)
- **Peppol BIS 3.0 rules** (OpenPEPPOL, MPL-2.0)

## Supported UBL Document Types

The extension validates all UBL 2.1 document types including:
- Invoice, CreditNote, DebitNote
- Order, OrderResponse, OrderChange, OrderCancellation
- DespatchAdvice, ReceiptAdvice
- Catalogue, CatalogueRequest, CataloguePricingUpdate
- Quotation, RequestForQuotation
- ApplicationResponse, Statement, RemittanceAdvice
- And 50+ more...

## Examples

### Valid UBL Invoice
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <cbc:ID>INV-2025-001</cbc:ID>
  <cbc:IssueDate>2025-02-01</cbc:IssueDate>
  <!-- Full UBL structure -->
</Invoice>
```

Validation passes with no errors

### Validation Results
- **Errors** appear as red squiggles on the specific line
- **Warnings** appear as yellow squiggles
- **Rule IDs** shown in brackets: `[BR-01] Invoice must contain supplier name`
- Click any issue to jump to the line

## Release Notes

### 1.3.0
- Bundled Saxon-HE 10.9: no need to install Saxon separately
- Bundled Java XSD validator: `xmllint` is now optional
- `xsltproc` is now optional: falls back to bundled Saxon for XSLT transforms
- Java is the only required system dependency
- Non-blocking Java availability check on activation with install link

### 1.2.0
- Auto-validation after XSLT transform: when output is detected as UBL, XSD + EN16931 + Peppol validation runs automatically
- XSLT error tracing: validation errors link back to the exact element-producing line in your XSLT stylesheet
- Element-level error placement: errors appear on the specific UBL element in the output, not the root tag
- Rule ID coverage for 65+ EN16931 and Peppol root-level rules with static element mapping
- Missing element Quick Fix suggestions in the editor
- Cross-platform compatibility fixes (Windows path handling, CRLF line endings)

### 1.1.0
- Full UBL 2.1 validation support
- XSD schema validation for all 65+ UBL document types
- EN16931 European e-invoicing standard validation
- Peppol BIS 3.0 business rules
- Inline diagnostics with precise line numbers
- Keyboard shortcut: `Cmd+Shift+V` / `Ctrl+Shift+V`

### 1.0.0
- Initial XSLT transformation functionality

## Support

If you find this extension useful, consider [supporting development on Ko-fi](https://ko-fi.com/andreivasilcin)

## Contributing

Issues and pull requests welcome at [GitHub](https://github.com/vasilcinandrei/xslt-transformer-vscode)

## License

MIT License - Copyright (c) 2025 Andrei Vasilcin

Bundled validation artifacts have their own licenses:
- UBL 2.1 XSD: OASIS IPR Policy
- EN16931: EUPL-1.2
- Peppol BIS 3.0: MPL-2.0
- Saxon-HE 10.9: MPL-2.0

See `validation-artifacts/README.md` for details.
