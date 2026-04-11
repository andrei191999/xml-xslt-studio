#!/usr/bin/env bash
# Downloads UBL 2.1 XSD schemas and pre-compiled Schematron XSLT files
# for EN16931 and Peppol BIS 3.0 validation.
#
# Usage: ./scripts/download-artifacts.sh
#
# Requirements:
#   - curl
#   - unzip
#   - Saxon (java -jar saxon-he.jar) for Schematron compilation (optional)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ARTIFACTS_DIR="$PROJECT_DIR/validation-artifacts"
TEMP_DIR="$(mktemp -d)"

# Prefer macOS system curl (uses SecureTransport) over Homebrew curl (OpenSSL)
# to avoid SSL certificate issues
if [ -x /usr/bin/curl ]; then
    CURL="/usr/bin/curl"
else
    CURL="curl"
fi
CURL_OPTS=(-L --fail --retry 3 --retry-delay 2)

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# ─── Saxon-HE (bundled XSLT 2.0 processor) ────────────────────────

echo "=== Downloading Saxon-HE 10.9 ==="
SAXON_URL="https://repo1.maven.org/maven2/net/sf/saxon/Saxon-HE/10.9/Saxon-HE-10.9.jar"
mkdir -p "$PROJECT_DIR/lib"
if [ ! -f "$PROJECT_DIR/lib/saxon-he-10.9.jar" ]; then
    echo "Source: $SAXON_URL"
    "$CURL" "${CURL_OPTS[@]}" -o "$PROJECT_DIR/lib/saxon-he-10.9.jar" "$SAXON_URL"
    echo "Saxon-HE 10.9 downloaded."
else
    echo "Saxon-HE 10.9 already present, skipping."
fi

# ─── UBL 2.1 XSD ───────────────────────────────────────────────────

echo "=== Downloading UBL 2.1 XSD Schemas ==="
UBL_XSD_URL="https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip"
echo "Source: $UBL_XSD_URL"
"$CURL" "${CURL_OPTS[@]}" -o "$TEMP_DIR/ubl-2.1.zip" "$UBL_XSD_URL"
unzip -q "$TEMP_DIR/ubl-2.1.zip" -d "$TEMP_DIR/ubl"

# Find the XSD directories - structure varies between sources
XSD_MAINDOC=$(find "$TEMP_DIR/ubl" -type d -name "maindoc" | head -1)
XSD_COMMON=$(find "$TEMP_DIR/ubl" -type d -name "common" | head -1)

if [ -n "$XSD_MAINDOC" ] && [ -n "$XSD_COMMON" ]; then
    rm -rf "$ARTIFACTS_DIR/xsd/ubl-2.1/maindoc" "$ARTIFACTS_DIR/xsd/ubl-2.1/common"
    mkdir -p "$ARTIFACTS_DIR/xsd/ubl-2.1"
    cp -r "$XSD_MAINDOC" "$ARTIFACTS_DIR/xsd/ubl-2.1/"
    cp -r "$XSD_COMMON" "$ARTIFACTS_DIR/xsd/ubl-2.1/"
    echo "UBL 2.1 XSD schemas installed."
else
    echo "ERROR: Could not find XSD directories in downloaded archive."
    exit 1
fi

# ─── EN16931 ────────────────────────────────────────────────────────

echo ""
echo "=== Downloading EN16931 Schematron (pre-compiled XSLT) ==="
EN16931_VERSION="1.3.13"
EN16931_URL="https://github.com/ConnectingEurope/eInvoicing-EN16931/releases/download/validation-$EN16931_VERSION/en16931-ubl-$EN16931_VERSION.zip"
echo "Source: $EN16931_URL (version $EN16931_VERSION)"
"$CURL" "${CURL_OPTS[@]}" -o "$TEMP_DIR/en16931.zip" "$EN16931_URL"
unzip -q "$TEMP_DIR/en16931.zip" -d "$TEMP_DIR/en16931" || true

EN16931_XSLT=$(find "$TEMP_DIR/en16931" -name "*.xslt" -o -name "*.xsl" | head -1)
if [ -n "$EN16931_XSLT" ]; then
    mkdir -p "$ARTIFACTS_DIR/schematron/en16931"
    cp "$EN16931_XSLT" "$ARTIFACTS_DIR/schematron/en16931/EN16931-UBL-validation.xslt"
    echo "EN16931 XSLT installed."
else
    echo "WARNING: Could not find EN16931 pre-compiled XSLT."
    echo "You may need to compile from .sch manually."
fi

# ─── Peppol BIS 3.0 ────────────────────────────────────────────────

echo ""
echo "=== Downloading Peppol BIS 3.0 Schematron ==="
PEPPOL_VERSION="3.0.19"
PEPPOL_URL="https://github.com/OpenPEPPOL/peppol-bis-invoice-3/archive/refs/tags/v${PEPPOL_VERSION}.zip"
echo "Source: $PEPPOL_URL (version $PEPPOL_VERSION)"
"$CURL" "${CURL_OPTS[@]}" -o "$TEMP_DIR/peppol.zip" "$PEPPOL_URL"
unzip -q "$TEMP_DIR/peppol.zip" -d "$TEMP_DIR/peppol"

# The repo contains raw .sch files that need compilation to XSLT
PEPPOL_SCH=$(find "$TEMP_DIR/peppol" -path "*/sch/PEPPOL-EN16931-UBL.sch" | head -1)
mkdir -p "$ARTIFACTS_DIR/schematron/peppol"

if [ -n "$PEPPOL_SCH" ]; then
    echo "Found Schematron source: $PEPPOL_SCH"

    # Copy the raw .sch file for reference
    cp "$PEPPOL_SCH" "$ARTIFACTS_DIR/schematron/peppol/PEPPOL-EN16931-UBL.sch"

    # Also copy the include files that the .sch references
    SCH_DIR=$(dirname "$PEPPOL_SCH")
    find "$SCH_DIR" -name "*.sch" -exec cp {} "$ARTIFACTS_DIR/schematron/peppol/" \;

    # Try to compile using Saxon if available
    if command -v java &>/dev/null; then
        echo "Attempting Schematron-to-XSLT compilation with Saxon..."

        # Download ISO Schematron XSLT2 skeleton if not present
        SCHXSLT_URL="https://github.com/schxslt/schxslt/releases/download/v1.9.5/schxslt-1.9.5-xslt-only.zip"
        "$CURL" "${CURL_OPTS[@]}" -o "$TEMP_DIR/schxslt.zip" "$SCHXSLT_URL" 2>/dev/null || true

        if [ -f "$TEMP_DIR/schxslt.zip" ]; then
            unzip -q "$TEMP_DIR/schxslt.zip" -d "$TEMP_DIR/schxslt" 2>/dev/null || true
            COMPILE_XSLT=$(find "$TEMP_DIR/schxslt" -name "pipeline-for-svrl.xsl" | head -1)

            if [ -n "$COMPILE_XSLT" ]; then
                # Check for Saxon - prefer bundled JAR
                SAXON_JAR=""
                if [ -f "$PROJECT_DIR/lib/saxon-he-10.9.jar" ]; then
                    SAXON_JAR="$PROJECT_DIR/lib/saxon-he-10.9.jar"
                else
                    for jar in /usr/local/share/saxon/*.jar /opt/homebrew/share/saxon/*.jar "$HOME"/.m2/repository/net/sf/saxon/Saxon-HE/*/Saxon-HE-*.jar; do
                        if [ -f "$jar" ]; then
                            SAXON_JAR="$jar"
                            break
                        fi
                    done
                fi

                if [ -n "$SAXON_JAR" ]; then
                    echo "Using Saxon: $SAXON_JAR"
                    java -jar "$SAXON_JAR" \
                        -s:"$PEPPOL_SCH" \
                        -xsl:"$COMPILE_XSLT" \
                        -o:"$ARTIFACTS_DIR/schematron/peppol/PEPPOL-EN16931-UBL.xslt" \
                        2>/dev/null && echo "Peppol XSLT compiled successfully." || echo "WARNING: Saxon compilation failed."
                else
                    echo "WARNING: Saxon not found. Install Saxon-HE to compile Schematron."
                    echo "  brew install saxon or download from https://www.saxonica.com/download/java.xml"
                fi
            fi
        fi
    else
        echo "WARNING: Java not found. Cannot compile Schematron to XSLT."
    fi

    if [ ! -f "$ARTIFACTS_DIR/schematron/peppol/PEPPOL-EN16931-UBL.xslt" ]; then
        echo ""
        echo "NOTE: Peppol .sch files saved but not compiled to XSLT."
        echo "To compile manually:"
        echo "  1. Install Saxon-HE: brew install saxon"
        echo "  2. Download SchXslt: https://github.com/schxslt/schxslt/releases"
        echo "  3. Run: java -jar saxon-he.jar -s:PEPPOL-EN16931-UBL.sch -xsl:pipeline-for-svrl.xsl -o:PEPPOL-EN16931-UBL.xslt"
    fi
else
    echo "WARNING: Could not find PEPPOL-EN16931-UBL.sch in the archive."
fi

# ─── Summary ────────────────────────────────────────────────────────

echo ""
echo "=== Done ==="
echo "Artifacts installed to: $ARTIFACTS_DIR"
echo ""
echo "Directory structure:"
find "$ARTIFACTS_DIR" -type f | sort | head -30
TOTAL=$(find "$ARTIFACTS_DIR" -type f | wc -l | tr -d ' ')
echo "... ($TOTAL files total)"
