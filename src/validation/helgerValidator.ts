import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import { IssueSeverity, ValidationIssue, UblDocumentInfo } from './types';
import { XmlXsltConfig } from '../config/settings';
import { resolveLineFromXPath } from '../utils/xpathLineResolver';

// ---------------------------------------------------------------------------
// VESID catalog (used for QuickPick fallback)
// ---------------------------------------------------------------------------

const VESID_CATALOG = [
    // Peppol BIS 3.0 — Invoice / Credit Note
    { label: 'Peppol BIS 3.0 Invoice (2025.11)',                      vesid: 'eu.peppol.bis3:invoice:2025.11',                 docTypes: ['Invoice'] },
    { label: 'Peppol BIS 3.0 Credit Note (2025.11)',                  vesid: 'eu.peppol.bis3:creditnote:2025.11',              docTypes: ['CreditNote'] },
    { label: 'Peppol BIS 3.0 Invoice Self-Billing (2025.3)',          vesid: 'eu.peppol.bis3:invoice-self-billing:2025.3',     docTypes: ['Invoice'] },
    { label: 'Peppol BIS 3.0 Credit Note Self-Billing (2025.3)',      vesid: 'eu.peppol.bis3:creditnote-self-billing:2025.3',  docTypes: ['CreditNote'] },
    // Peppol BIS 3.0 — Other document types
    { label: 'Peppol BIS 3.0 Order (2025.11)',                        vesid: 'eu.peppol.bis3:order:2025.11',                  docTypes: ['Order'] },
    { label: 'Peppol BIS 3.0 Order Response (2025.11)',               vesid: 'eu.peppol.bis3:order-response:2025.11',         docTypes: ['OrderResponse'] },
    { label: 'Peppol BIS 3.0 Despatch Advice (2025.11)',              vesid: 'eu.peppol.bis3:despatch-advice:2025.11',        docTypes: ['DespatchAdvice'] },
    { label: 'Peppol BIS 3.0 Catalogue (2025.11)',                    vesid: 'eu.peppol.bis3:catalogue:2025.11',              docTypes: ['Catalogue'] },
    { label: 'Peppol BIS 3.0 Catalogue Response (2025.11)',           vesid: 'eu.peppol.bis3:catalogue-response:2025.11',     docTypes: ['ApplicationResponse'] },
    { label: 'Peppol BIS 3.0 MLR (2025.11)',                          vesid: 'eu.peppol.bis3:mlr:2025.11',                    docTypes: ['ApplicationResponse'] },
    { label: 'Peppol BIS 3.0 Invoice Response (2025.11)',             vesid: 'eu.peppol.bis3:invoice-response:2025.11',       docTypes: ['ApplicationResponse'] },
    { label: 'Peppol BIS 3.0 Punch Out (2025.11)',                    vesid: 'eu.peppol.bis3:punch-out:2025.11',              docTypes: ['Catalogue'] },
    { label: 'Peppol BIS 3.0 Order Agreement (2025.11)',              vesid: 'eu.peppol.bis3:order-agreement:2025.11',        docTypes: ['OrderResponse'] },
    // EN 16931
    { label: 'EN 16931 UBL Invoice (1.3.15)',                         vesid: 'eu.cen.en16931:invoice:1.3.15',                 docTypes: ['Invoice'] },
    { label: 'EN 16931 UBL Credit Note (1.3.15)',                     vesid: 'eu.cen.en16931:creditnote:1.3.15',              docTypes: ['CreditNote'] },
    // XRechnung
    { label: 'XRechnung UBL Invoice (3.0.1)',                         vesid: 'de.xrechnung:ubl-invoice:3.0.1',                docTypes: ['Invoice'] },
    { label: 'XRechnung UBL Credit Note (3.0.1)',                     vesid: 'de.xrechnung:ubl-creditnote:3.0.1',             docTypes: ['CreditNote'] },
    // PINT
    { label: 'PINT Invoice (1.1.2)',                                   vesid: 'org.peppol.pint:invoice:1.1.2',                 docTypes: ['Invoice'] },
    { label: 'PINT AU/NZ Invoice (1.1.2)',                            vesid: 'org.peppol.pint.aunz:invoice:1.1.2',            docTypes: ['Invoice'] },
    { label: 'PINT AU/NZ Credit Note (1.1.2)',                        vesid: 'org.peppol.pint.aunz:creditnote:1.1.2',         docTypes: ['CreditNote'] },
    { label: 'PINT Singapore Invoice (1.0.3)',                        vesid: 'org.peppol.pint.sg:invoice:1.0.3',              docTypes: ['Invoice'] },
    { label: 'PINT Malaysia Invoice (1.0.0)',                         vesid: 'org.peppol.pint.my:invoice:1.0.0',              docTypes: ['Invoice'] },
    { label: 'PINT Japan Invoice (1.1.2)',                            vesid: 'org.peppol.pint.jp:invoice:1.1.2',              docTypes: ['Invoice'] },
    // Country profiles
    { label: 'Italy Peppol Invoice (3.2.1)',                          vesid: 'it.peppol:invoice:3.2.1',                       docTypes: ['Invoice'] },
    { label: 'Italy Peppol Credit Note (3.2.1)',                      vesid: 'it.peppol:creditnote:3.2.1',                    docTypes: ['CreditNote'] },
    { label: 'Norway EHF G3 Invoice (3.0.3)',                         vesid: 'no.ehf.g3:invoice:3.0.3',                       docTypes: ['Invoice'] },
    { label: 'Norway EHF G3 Credit Note (3.0.3)',                     vesid: 'no.ehf.g3:creditnote:3.0.3',                    docTypes: ['CreditNote'] },
    { label: 'CIUS-PT UBL Invoice (2.1.1)',                           vesid: 'pt.gov.espap.cius-pt:ubl-invoice:2.1.1',        docTypes: ['Invoice'] },
    { label: 'CIUS-RO UBL Invoice (1.0.9)',                           vesid: 'ro.gov.mfinante.cius-ro:ubl-invoice:1.0.9',     docTypes: ['Invoice'] },
    // Reporting / Directory / Other
    { label: 'Peppol Directory Business Card v3',                     vesid: 'eu.peppol.directory:businesscard:3',            docTypes: ['*'] },
    { label: 'Peppol Reporting EUSR (1.1.5)',                         vesid: 'eu.peppol.reporting:eusr:1.1.5',                docTypes: ['*'] },
    { label: 'Peppol Reporting TSR (1.1.1)',                          vesid: 'eu.peppol.reporting:tsr:1.1.1',                 docTypes: ['*'] },
    { label: 'Peppol MLS (1)',                                        vesid: 'org.peppol:mls:1',                              docTypes: ['*'] },
    { label: 'UN/CEFACT CII D22B',                                    vesid: 'un.unece.uncefact:crossindustryinvoice:D22B',   docTypes: ['*'] },
    { label: 'ZUGFeRD EN16931 (2.4)',                                 vesid: 'de.zugferd:en16931:2.4',                        docTypes: ['*'] },
    { label: 'ebInterface Invoice (6.1)',                              vesid: 'at.ebinterface:invoice:6.1',                    docTypes: ['Invoice'] },
] as const;

type CatalogEntry = typeof VESID_CATALOG[number];

// ---------------------------------------------------------------------------
// Multi-profile VESID resolution
// ---------------------------------------------------------------------------

interface CustomizationEntry {
    prefix: string;
    vesidGroup: string;
}

/**
 * Ordered list of CustomizationID prefixes mapped to VESID group IDs.
 * More specific prefixes must appear before less specific ones.
 * Verified group IDs from phive-rules source (github.com/phax/phive-rules).
 */
const CUSTOMIZATION_MAP: CustomizationEntry[] = [
    // Peppol BIS 3.0 Europe
    { prefix: 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
      vesidGroup: 'eu.peppol.bis3' },
    // XRechnung 3.x (compliant with EN16931)
    { prefix: 'urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.',
      vesidGroup: 'de.xrechnung' },
    // XRechnung 2.x (compliant with EN16931)
    { prefix: 'urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.',
      vesidGroup: 'de.xrechnung' },
    // NLCIUS (SimplerInvoicing)
    { prefix: 'urn:cen.eu:en16931:2017#compliant#urn:fdc:nen.nl:2020:nlcius:v1.0',
      vesidGroup: 'org.simplerinvoicing' },
    // CIUS-PT (Portugal)
    { prefix: 'urn:cen.eu:en16931:2017#compliant#urn:fdc:cec-icpic.com:cpt:1.0',
      vesidGroup: 'pt.gov.espap.cius-pt' },
    // CIUS-RO (Romania eFaktura)
    { prefix: 'urn:cen.eu:en16931:2017#compliant#urn:fdc:anaf.ro:2020',
      vesidGroup: 'ro.gov.mfinante.cius-ro' },
    // EN16931 base (catch-all for urn:cen.eu:en16931:2017 — must be after more specific prefixes)
    { prefix: 'urn:cen.eu:en16931:2017',
      vesidGroup: 'eu.cen.en16931' },
    // PINT JP
    { prefix: 'urn:peppol:pint:billing-1@jp',   vesidGroup: 'org.peppol.pint.jp' },
    // PINT MY
    { prefix: 'urn:peppol:pint:billing-1@my',   vesidGroup: 'org.peppol.pint.my' },
    // PINT AU/NZ (generic billing-1 — must follow country-specific variants)
    { prefix: 'urn:peppol:pint:billing-1',       vesidGroup: 'org.peppol.pint.aunz' },
    // Peppol BIS 3.0 Singapore (PINT SG)
    { prefix: 'urn:peppol:bis:billing:3',        vesidGroup: 'org.peppol.pint.sg' },
];

/** vesidGroup → docType → artifact name (as used in VESID string) */
const DOC_TYPE_ARTIFACT: Record<string, Record<string, string>> = {
    'eu.peppol.bis3':             { Invoice: 'invoice',         CreditNote: 'creditnote' },
    'eu.cen.en16931':             { Invoice: 'invoice',         CreditNote: 'creditnote' },
    'de.xrechnung':               { Invoice: 'ubl-invoice',     CreditNote: 'ubl-creditnote' },
    'org.simplerinvoicing':       { Invoice: 'invoice',         CreditNote: 'creditnote' },
    'pt.gov.espap.cius-pt':       { Invoice: 'ubl-invoice' },
    'ro.gov.mfinante.cius-ro':    { Invoice: 'ubl-invoice' },
    'org.peppol.pint.jp':         { Invoice: 'invoice' },
    'org.peppol.pint.my':         { Invoice: 'invoice' },
    'org.peppol.pint.aunz':       { Invoice: 'invoice',         CreditNote: 'creditnote' },
    'org.peppol.pint.sg':         { Invoice: 'invoice' },
};

/** vesidGroup → previous version (for `versionKey === "previous"`). */
const VESID_PREVIOUS_VERSION: Record<string, string> = {
    'eu.peppol.bis3': '2025.5.0',
};

/**
 * vesidGroup → latest version string.
 * Sourced directly from the Helger validation service (April 2026).
 */
const VESID_LATEST_VERSION: Record<string, string> = {
    'eu.peppol.bis3':          '2025.11.0',
    'eu.cen.en16931':          '1.3.15',
    'de.xrechnung':            '3.0.1',
    'org.simplerinvoicing':    '2.0.3.12',
    'pt.gov.espap.cius-pt':    '2.1.1',
    'ro.gov.mfinante.cius-ro': '1.0.9',
    'org.peppol.pint.jp':      '1.1.2',
    'org.peppol.pint.my':      '1.0.0',
    'org.peppol.pint.aunz':    '1.1.2',
    'org.peppol.pint.sg':      '1.0.3',
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Escape XML special characters so document content can be embedded as text. */
export function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** Build the SOAP 1.1 envelope for the Helger document validation service. */
export function buildSoapEnvelope(xmlContent: string, vesid: string): string {
    const safeVesid = escapeXml(vesid);
    const safeXml   = escapeXml(xmlContent);
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<soapenv:Envelope\n' +
        '    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"\n' +
        '    xmlns:ns="http://peppol.helger.com/ws/documentvalidationservice/201701/">\n' +
        '  <soapenv:Header/>\n' +
        '  <soapenv:Body>\n' +
        '    <ns:validateRequestInput VESID="' + safeVesid + '" displayLocale="en">\n' +
        '      <ns:XML>' + safeXml + '</ns:XML>\n' +
        '    </ns:validateRequestInput>\n' +
        '  </soapenv:Body>\n' +
        '</soapenv:Envelope>'
    );
}

/**
 * POST a SOAP envelope to the given endpoint.
 * Throws if the HTTP status is >= 400 or the response contains a SOAP Fault.
 */
export function postSoap(endpoint: string, body: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint);
        const isHttps = url.protocol === 'https:';
        const transport: typeof https | typeof http = isHttps ? https : http;

        const bodyBuf = Buffer.from(body, 'utf8');

        const options: https.RequestOptions = {
            hostname: url.hostname,
            port: url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=UTF-8',
                'SOAPAction': '"validate"',
                'Content-Length': bodyBuf.length,
            },
        };

        const req = transport.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const responseText = Buffer.concat(chunks).toString('utf8');
                const status = res.statusCode ?? 0;
                if (status >= 400) {
                    reject(new Error('Helger SOAP request failed with HTTP ' + status + ': ' + responseText));
                    return;
                }
                if (responseText.includes('<faultcode') || responseText.includes(':Fault')) {
                    const faultMatch = responseText.match(/<faultstring[^>]*>([^<]*)<\/faultstring>/);
                    const faultMsg = faultMatch ? faultMatch[1] : 'Unknown SOAP Fault';
                    reject(new Error('Helger SOAP Fault: ' + faultMsg + '\n' + responseText));
                    return;
                }
                resolve(responseText);
            });
            res.on('error', reject);
        });

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error('Helger SOAP request timed out after ' + timeoutMs + 'ms'));
        });

        req.on('error', reject);
        req.write(bodyBuf);
        req.end();
    });
}

/**
 * Parse the SOAP response XML into ValidationIssue[].
 * errorLevel "ERROR" -> Error, "WARN" -> Warning, "SUCCESS" -> skipped.
 * When xmlContent is provided, XPath expressions in errorFieldName are resolved to line numbers.
 */
export function parseSoapResponse(responseXml: string, xmlContent?: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    const itemMatches = responseXml.match(/<Item\b[^>]*?(?:\/>|>[\s\S]*?<\/Item>)/g);
    if (!itemMatches) {
        return issues;
    }

    const sourceLines = xmlContent ? xmlContent.split(/\r?\n/) : undefined;

    for (const itemXml of itemMatches) {
        const attrMatch = itemXml.match(/^<Item\b([\s\S]*?)(?:\/>|>)/);
        if (!attrMatch) {
            continue;
        }
        const attrs = attrMatch[1];

        const errorLevel = extractAttr(attrs, 'errorLevel');
        if (!errorLevel || errorLevel === 'SUCCESS') {
            continue;
        }

        const severity =
            errorLevel === 'ERROR' ? IssueSeverity.Error
            : errorLevel === 'WARN' ? IssueSeverity.Warning
            : IssueSeverity.Information;

        const message   = extractAttr(attrs, 'errorText') ?? '(no message)';
        const ruleId    = extractAttr(attrs, 'errorID') ?? undefined;
        const fieldName = extractAttr(attrs, 'errorFieldName');

        let line   = 1;
        let column = 0;
        if (fieldName) {
            if ((fieldName.startsWith('/') || fieldName.startsWith('./')) && sourceLines) {
                // XPath expression — resolve to line number
                line = resolveLineFromXPath(fieldName, sourceLines);
            } else {
                // Try "line: N" pattern
                const lineMatch = fieldName.match(/line[:\s]+(\d+)/i);
                if (lineMatch) {
                    line = parseInt(lineMatch[1], 10);
                }
            }
        }

        issues.push({ severity, message, ruleId, line, column, source: 'helger' });
    }

    return issues;
}

/** Extract the text content of <cbc:CustomizationID> (any prefix variant). */
export function detectCustomizationId(xmlContent: string): string | undefined {
    const m = xmlContent.match(/<[^>]*:?CustomizationID[^>]*>([^<]*)<\/[^>]*:?CustomizationID>/);
    if (!m) {
        return undefined;
    }
    return m[1].trim() || undefined;
}

/**
 * Resolve a VESID from CustomizationID text, document type, and version key.
 * versionKey: "latest" → use group's latest version, "previous" → same as latest (no universal
 * previous for non-Peppol profiles), or use versionKey as-is for explicit version strings.
 * Returns undefined when no matching entry is found.
 */
export function resolveVesidFromProfile(
    customId: string,
    docType: string,
    versionKey: string,
): string | undefined {
    // Find matching entry by prefix (order matters — most specific first)
    const entry = CUSTOMIZATION_MAP.find(e => customId.startsWith(e.prefix));
    if (!entry) {
        return undefined;
    }

    const artifact = DOC_TYPE_ARTIFACT[entry.vesidGroup]?.[docType];
    if (!artifact) {
        return undefined;
    }

    const latestVersion = VESID_LATEST_VERSION[entry.vesidGroup] ?? '1.0.0';
    const version = versionKey === 'latest' ? latestVersion
        : versionKey === 'previous' ? (VESID_PREVIOUS_VERSION[entry.vesidGroup] ?? latestVersion)
        : versionKey;

    return `${entry.vesidGroup}:${artifact}:${version}`;
}

// ---------------------------------------------------------------------------
// VS Code orchestrator
// ---------------------------------------------------------------------------

/**
 * Run Helger online SOAP validation for a UBL document.
 * Auto-detects VESID from CustomizationID (checking user custom mappings first);
 * falls back to a QuickPick when no match is found.
 * Returns [] if the user cancels or a network error occurs.
 */
export async function validateHelger(
    xmlContent: string,
    docInfo: UblDocumentInfo,
    config: XmlXsltConfig,
    detectedProfile?: string,   // VESID string from DDD (e.g. "eu.peppol.bis3:invoice:2025.11")
): Promise<ValidationIssue[]> {
    // If DDD already detected the profile, use it directly
    let vesid: string | undefined;
    if (detectedProfile) {
        vesid = detectedProfile; // PhiveRunner already determined the VESID
    }

    const customId = detectedProfile ? undefined : detectCustomizationId(xmlContent);

    if (!vesid && customId) {
        // Check user-defined custom mappings before the built-in table
        const customMappings = vscode.workspace.getConfiguration('xmlXslt').get<
            Array<{ customizationIdPrefix: string; vesid: string }>
        >('validation.helger.customVesidMappings', []);

        const customMatch = customMappings.find(m => customId.startsWith(m.customizationIdPrefix));
        if (customMatch) {
            vesid = customMatch.vesid;
        } else {
            vesid = resolveVesidFromProfile(customId, docInfo.docType, config.validation.helgerVesidVersion);
        }
    }

    if (!vesid) {
        vscode.window.showWarningMessage(
            'Could not detect Peppol profile from CustomizationID - select a validation ruleset.',
        );

        const filtered = (VESID_CATALOG as readonly CatalogEntry[]).filter(
            (e) => (e.docTypes as readonly string[]).some(t => t === '*' || t === docInfo.docType),
        );

        const CUSTOM_ITEM = 'Custom VESID...';
        const picks: vscode.QuickPickItem[] = [
            ...filtered.map((e) => ({ label: e.label, description: e.vesid })),
            { label: CUSTOM_ITEM },
        ];

        const selected = await vscode.window.showQuickPick(picks, {
            placeHolder: 'Select Peppol validation ruleset',
            ignoreFocusOut: true,
        });

        if (!selected) {
            return [];
        }

        if (selected.label === CUSTOM_ITEM) {
            const custom = await vscode.window.showInputBox({
                prompt: 'Enter VESID',
                placeHolder: 'eu.peppol.bis3:invoice:2025.11.0',
                ignoreFocusOut: true,
            });
            if (!custom) {
                return [];
            }
            vesid = custom.trim();
        } else {
            vesid = selected.description;
        }
    }

    if (!vesid) {
        return [];
    }

    const envelope = buildSoapEnvelope(xmlContent, vesid);
    try {
        const responseText = await postSoap(
            config.validation.helgerEndpoint,
            envelope,
            config.validation.helgerTimeoutMs,
        );
        return parseSoapResponse(responseText, xmlContent);
    } catch {
        // Network error, timeout, or SOAP Fault — return empty rather than propagate
        return [];
    }
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

/** Extract the value of a named XML attribute from an attribute-text fragment. */
function extractAttr(attrs: string, name: string): string | undefined {
    const re = new RegExp(name + '=(?:"([^"]*)"|\'([^\']*)\')' , 'i');
    const m = attrs.match(re);
    if (!m) {
        return undefined;
    }
    return (m[1] ?? m[2])
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
