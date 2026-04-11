import * as vscode from 'vscode';

export interface ValidationIssue {
    line: number;
    column: number;
    message: string;
    severity: vscode.DiagnosticSeverity;
    ruleId?: string;
    source: 'xsd' | 'en16931' | 'peppol';
}

export interface UblDocumentInfo {
    rootElement: string;
    namespace: string;
    documentType: string;
    isInvoiceOrCreditNote: boolean;
}

export interface ValidationResult {
    issues: ValidationIssue[];
    documentInfo: UblDocumentInfo | null;
    xsdPassed: boolean;
    en16931Passed: boolean | null; // null if not applicable
    peppolPassed: boolean | null;  // null if not applicable
}

export type ValidationScope = 'full' | 'xsd-only' | 'business-rules-only';
