import { ValidationIssue, UblDocumentInfo } from './types';

/**
 * XSD validation is handled by PhiveRunner (via schematronValidator).
 * This function is a no-op — phive runs XSD and Schematron in a single pass.
 */
export async function validateXsd(
    _xmlContent: string,
    _docInfo: UblDocumentInfo,
    _artifactsPath: string,
    _extensionPath: string
): Promise<ValidationIssue[]> {
    return [];
}
