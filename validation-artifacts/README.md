# Validation Artifacts

This directory contains the validation schemas and pre-compiled Schematron XSLT files
used by the UBL Validator extension.

## Contents

### XSD Schemas (`xsd/ubl-2.1/`)
- **Source**: [OASIS UBL 2.1](https://docs.oasis-open.org/ubl/UBL-2.1.html)
- **License**: OASIS open standard, royalty-free
- Contains `maindoc/` (per-document XSDs) and `common/` (shared components)

### EN16931 Schematron (`schematron/en16931/`)
- **Source**: [ConnectingEurope/eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931)
- **License**: EUPL 1.2
- Pre-compiled XSLT from EN16931 business rules for UBL invoices

### Peppol BIS 3.0 Schematron (`schematron/peppol/`)
- **Source**: [OpenPEPPOL/peppol-bis-invoice-3](https://github.com/OpenPEPPOL/peppol-bis-invoice-3)
- **License**: MPL 2.0
- Pre-compiled XSLT from Peppol BIS 3.0 business rules

## Updating

Run `scripts/download-artifacts.sh` to download the latest versions.
