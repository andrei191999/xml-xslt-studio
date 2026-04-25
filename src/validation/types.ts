// IssueSeverity mirrors vscode.DiagnosticSeverity numeric values so that
// diagnosticsReporter.ts can cast: (issue.severity as unknown as vscode.DiagnosticSeverity)
export enum IssueSeverity {
    Error       = 0,
    Warning     = 1,
    Information = 2,
}

export interface ValidationIssue {
    severity: IssueSeverity;
    message: string;
    ruleId?: string;           // e.g. "BR-S-02" for Schematron rules
    line: number;              // 1-based
    column: number;            // 1-based, 0 if unknown
    source: 'local-xsd' | 'local-schematron' | 'helger';
}

export interface UblDocumentInfo {
    rootElement: string;       // e.g. "Invoice", "CreditNote"
    namespace: string;         // e.g. "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
    docType: string;           // same as rootElement for UBL
    xsdPath: string;           // absolute path to matching XSD, e.g. ".../UBL-Invoice-2.1.xsd"
}

export enum SchematronRuleset {
    EN16931 = 'en16931',
    Peppol  = 'peppol',
}
