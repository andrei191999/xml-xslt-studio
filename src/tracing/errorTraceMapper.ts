import { TraceEntry } from './xsltTracer';
import { ValidationIssue } from '../validation/types';

export interface TracedIssue extends ValidationIssue {
    xsltSourceFile?: string;
    xsltSourceLine?: number;
    xsltElementName?: string;
}

/**
 * Static map from Schematron rule IDs to the UBL element(s) they target.
 * Derived from the test expressions in EN16931 and Peppol Schematron rules
 * that evaluate at the Invoice/CreditNote root. Most specific element first.
 */
const RULE_TARGET_ELEMENTS: Record<string, string[]> = {
    // EN16931 BR rules (root-level)
    'BR-01': ['CustomizationID'],
    'BR-02': ['ID'],
    'BR-03': ['IssueDate'],
    'BR-04': ['InvoiceTypeCode', 'CreditNoteTypeCode'],
    'BR-05': ['DocumentCurrencyCode'],
    'BR-06': ['RegistrationName', 'PartyLegalEntity', 'AccountingSupplierParty'],
    'BR-07': ['RegistrationName', 'PartyLegalEntity', 'AccountingCustomerParty'],
    'BR-08': ['PostalAddress', 'AccountingSupplierParty'],
    'BR-09': ['AddressLine', 'PostalAddress', 'AccountingSupplierParty'],
    'BR-10': ['PostalAddress', 'AccountingCustomerParty'],
    'BR-11': ['IdentificationCode', 'Country', 'PostalAddress'],
    'BR-12': ['LineExtensionAmount', 'LegalMonetaryTotal'],
    'BR-13': ['TaxExclusiveAmount', 'LegalMonetaryTotal'],
    'BR-14': ['TaxInclusiveAmount', 'LegalMonetaryTotal'],
    'BR-15': ['PayableAmount', 'LegalMonetaryTotal'],
    'BR-16': ['InvoiceLine', 'CreditNoteLine'],
    'BR-17': ['PayableRoundingAmount', 'LegalMonetaryTotal'],
    'BR-51': ['PrimaryAccountNumberID', 'CardAccount'],
    'BR-52': ['ID', 'AdditionalDocumentReference'],
    'BR-53': ['TaxCurrencyCode', 'TaxAmount', 'TaxTotal'],
    'BR-55': ['EndpointID', 'AccountingSupplierParty'],
    'BR-56': ['CompanyID', 'PartyTaxScheme', 'AccountingSupplierParty'],
    'BR-57': ['IdentificationCode', 'Country', 'DeliveryLocation'],
    'BR-61': ['PaymentMeansCode', 'PaymentMeans'],
    'BR-62': ['EndpointID', 'AccountingSupplierParty'],
    'BR-63': ['EndpointID', 'AccountingCustomerParty'],
    'BR-64': ['LineExtensionAmount', 'InvoiceLine'],
    'BR-65': ['TaxableAmount', 'TaxSubtotal', 'TaxTotal'],
    'BR-66': ['CardAccount', 'PaymentMeans'],
    'BR-67': ['PaymentMandate', 'PaymentMeans'],
    'BR-CO-03': ['TaxPointDate', 'InvoicePeriod'],
    'BR-CO-04': ['PayableAmount', 'LegalMonetaryTotal'],
    'BR-CO-10': ['LineExtensionAmount', 'LegalMonetaryTotal'],
    'BR-CO-11': ['AllowanceTotalAmount', 'LegalMonetaryTotal'],
    'BR-CO-12': ['ChargeTotalAmount', 'LegalMonetaryTotal'],
    'BR-CO-13': ['TaxExclusiveAmount', 'LegalMonetaryTotal'],
    'BR-CO-15': ['TaxInclusiveAmount', 'LegalMonetaryTotal'],
    'BR-CO-16': ['PayableAmount', 'LegalMonetaryTotal'],
    'BR-CO-18': ['TaxSubtotal', 'TaxTotal'],
    'BR-CO-25': ['PaymentDueDate', 'PaymentTerms'],
    'BR-CO-26': ['PrepaidAmount', 'LegalMonetaryTotal'],
    'BR-DEC-09': ['LineExtensionAmount', 'LegalMonetaryTotal'],
    'BR-DEC-10': ['AllowanceTotalAmount', 'LegalMonetaryTotal'],
    'BR-DEC-11': ['ChargeTotalAmount', 'LegalMonetaryTotal'],
    'BR-DEC-12': ['TaxExclusiveAmount', 'LegalMonetaryTotal'],
    'BR-DEC-13': ['TaxAmount', 'TaxTotal'],
    'BR-DEC-14': ['TaxInclusiveAmount', 'LegalMonetaryTotal'],
    'BR-DEC-15': ['TaxAmount', 'TaxTotal'],
    'BR-DEC-16': ['PrepaidAmount', 'LegalMonetaryTotal'],
    'BR-DEC-17': ['PayableRoundingAmount', 'LegalMonetaryTotal'],
    'BR-DEC-18': ['PayableAmount', 'LegalMonetaryTotal'],
    // Peppol root-level rules
    'PEPPOL-EN16931-R001': ['CustomizationID'],
    'PEPPOL-EN16931-R002': ['ProfileID'],
    'PEPPOL-EN16931-R004': ['TaxAmount', 'TaxTotal'],
    'PEPPOL-EN16931-R006': ['TaxAmount', 'TaxTotal'],
    'PEPPOL-EN16931-R007': ['TaxCurrencyCode'],
    'PEPPOL-EN16931-R008': ['DocumentCurrencyCode'],
    'PEPPOL-EN16931-R010': ['EndpointID', 'AccountingCustomerParty'],
    'PEPPOL-EN16931-R020': ['EndpointID', 'AccountingSupplierParty'],
    'PEPPOL-EN16931-R053': ['OrderReference'],
    'PEPPOL-EN16931-R054': ['InvoicePeriod'],
    'PEPPOL-EN16931-R055': ['AccountingCustomerParty'],
    'PEPPOL-EN16931-R061': ['PaymentMeansCode', 'PaymentMeans'],
    'PEPPOL-EN16931-R080': ['TaxSubtotal', 'TaxTotal'],
    'PEPPOL-EN16931-R100': ['Note'],
    'PEPPOL-EN16931-R101': ['Note'],
};

/**
 * Extracts element names to search for, using multiple strategies:
 * 1. Rule ID lookup (most reliable for root-level Schematron rules)
 * 2. Prefixed element names (cbc:X, cac:X)
 * 3. XSD error format
 * 4. UBL-CR path format ("should not include the X Y Z")
 * 5. PascalCase compound words as fallback
 */
function extractErrorElementNames(message: string, ruleId?: string): string[] {
    const names: string[] = [];

    // Strategy 1: Rule ID → known target elements
    if (ruleId && RULE_TARGET_ELEMENTS[ruleId]) {
        names.push(...RULE_TARGET_ELEMENTS[ruleId]);
    }

    // Strategy 2: XSD "Element '{ns}ElementName': ..."
    const xsdMatch = message.match(/Element\s+'(?:\{[^}]*\})?([A-Za-z][A-Za-z0-9_-]*)'/i);
    if (xsdMatch && !names.includes(xsdMatch[1])) {
        names.push(xsdMatch[1]);
    }

    // Strategy 3: Prefixed element names (cbc:X, cac:X)
    const nsRegex = /(?:cbc|cac|ubl|ext):([A-Za-z][A-Za-z0-9_-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = nsRegex.exec(message)) !== null) {
        if (!names.includes(m[1])) {
            names.push(m[1]);
        }
    }

    // Strategy 4: "Expected is ... {ns}ElementName"
    const expectedRegex = /Expected.*?\{[^}]*\}([A-Za-z][A-Za-z0-9_-]*)/g;
    while ((m = expectedRegex.exec(message)) !== null) {
        if (!names.includes(m[1])) {
            names.push(m[1]);
        }
    }

    // Strategy 5: UBL-CR path "should/shall/must not include the X Y Z"
    const crPathMatch = message.match(/(?:should|shall|must) not include the (.+)/i);
    if (crPathMatch) {
        const pathWords = crPathMatch[1]
            .split(/\s+/)
            .filter(w => /^[A-Z][a-zA-Z]{2,}$/.test(w));
        for (let i = pathWords.length - 1; i >= 0; i--) {
            if (!names.includes(pathWords[i])) {
                names.push(pathWords[i]);
            }
        }
    }

    // Strategy 6: PascalCase compound words (e.g. "AccountingSupplierParty")
    if (names.length === 0) {
        const pascalRegex = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
        while ((m = pascalRegex.exec(message)) !== null) {
            if (!names.includes(m[1])) {
                names.push(m[1]);
            }
        }
    }

    return names;
}

function traceMatchesElement(entry: TraceEntry, elementName: string): boolean {
    const traceBase = entry.elementName.includes(':')
        ? entry.elementName.split(':')[1]
        : entry.elementName;
    return traceBase === elementName;
}

/**
 * Find the 1-indexed line number where an element appears in the output XML.
 */
function findElementLineInOutput(elementName: string, outputLines: string[]): number | null {
    const regex = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${escapeRegex(elementName)}[\\s>\/]`);
    for (let i = 0; i < outputLines.length; i++) {
        if (regex.test(outputLines[i])) {
            return i + 1;
        }
    }
    return null;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ROOT_ELEMENTS = new Set(['Invoice', 'CreditNote', 'DebitNote', 'Order', 'OrderResponse',
    'DespatchAdvice', 'ReceiptAdvice', 'Catalogue', 'ApplicationResponse']);

/**
 * Maps validation issues to:
 * 1. The correct output line (relocating from root to the actual element)
 * 2. The XSLT source line that produces that element
 */
export function mapIssuesToXsltSource(
    issues: ValidationIssue[],
    traceEntries: TraceEntry[],
    outputContent?: string
): TracedIssue[] {
    if (traceEntries.length === 0 && !outputContent) {
        return issues.map(i => ({ ...i }));
    }

    const sorted = [...traceEntries].sort((a, b) => a.outputLine - b.outputLine);
    const outputLines = outputContent ? outputContent.split(/\r?\n/) : [];

    return issues.map(issue => {
        const traced: TracedIssue = { ...issue };
        const errorElements = extractErrorElementNames(issue.message, issue.ruleId);

        // Filter out root-level document type names
        const specificElements = errorElements.filter(n => !ROOT_ELEMENTS.has(n));

        if (specificElements.length === 0) {
            // No specific elements found — keep original position, try nearest trace
            if (issue.line > 2) {
                linkNearestTrace(traced, sorted);
            }
            return traced;
        }

        // Try to find a matching trace entry for each element name
        for (const elementName of specificElements) {
            const match = sorted.find(e => traceMatchesElement(e, elementName));
            if (match) {
                traced.line = match.outputLine;
                traced.xsltSourceFile = match.sourceFile;
                traced.xsltSourceLine = match.sourceLine;
                traced.xsltElementName = match.elementName;
                return traced;
            }
        }

        // No trace match — search the output XML directly
        if (outputLines.length > 0) {
            for (const elementName of specificElements) {
                const outputLine = findElementLineInOutput(elementName, outputLines);
                if (outputLine) {
                    traced.line = outputLine;
                    linkNearestTraceAt(traced, sorted, outputLine);
                    return traced;
                }
            }
        }

        // Keep original line, link nearest trace
        if (issue.line > 2) {
            linkNearestTrace(traced, sorted);
        }

        return traced;
    });
}

function linkNearestTrace(traced: TracedIssue, sorted: TraceEntry[]): void {
    linkNearestTraceAt(traced, sorted, traced.line);
}

function linkNearestTraceAt(traced: TracedIssue, sorted: TraceEntry[], line: number): void {
    let nearest: TraceEntry | null = null;
    for (const entry of sorted) {
        if (entry.outputLine <= line) {
            nearest = entry;
        } else {
            break;
        }
    }
    if (nearest) {
        traced.xsltSourceFile = nearest.sourceFile;
        traced.xsltSourceLine = nearest.sourceLine;
        traced.xsltElementName = nearest.elementName;
    }
}
