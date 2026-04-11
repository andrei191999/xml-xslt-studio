import { ValidationIssue } from '../validation/types';
import { XsltTemplate } from './xsltAnalyzer';

export interface MissingElementSuggestion {
    missingElement: string;
    parentElement: string;
    suggestedTemplate: XsltTemplate | null;
    issue: ValidationIssue;
}

// Regex patterns to detect "missing element" validation errors
const MISSING_ELEMENT_PATTERNS = [
    // XSD: "Element '{ns}Foo': Missing child element(s). Expected is..."
    /Missing child element\(s\).*?Expected.*?\{[^}]*\}(\w+)/i,
    // XSD: "Element 'Foo' is not expected"
    /element.*?'(?:\{[^}]*\})?(\w+)'.*?is not expected/i,
    // Schematron: "[BR-XX] ...element... must exist / is mandatory"
    /\[([A-Z]+-\d+)\].*?(?:must exist|is mandatory|shall exist)/i,
    // Generic: mentions "missing" and an element name
    /missing.*?(?:element|cbc:|cac:)\s*['"]?(\w+)/i,
];

// Extract the parent element context from XSD error messages
const PARENT_ELEMENT_PATTERN = /Element '(?:\{[^}]*\})?(\w+)'/;

/**
 * Analyzes validation issues for "missing element" errors and suggests
 * which XSLT template likely needs to be modified.
 */
export function suggestMissingElements(
    issues: ValidationIssue[],
    templates: XsltTemplate[]
): MissingElementSuggestion[] {
    const suggestions: MissingElementSuggestion[] = [];

    for (const issue of issues) {
        const missingElement = extractMissingElementName(issue.message);
        if (!missingElement) {
            continue;
        }

        const parentElement = extractParentElement(issue.message);

        // Find the template most likely responsible
        const suggestedTemplate = findResponsibleTemplate(parentElement, missingElement, templates);

        suggestions.push({
            missingElement,
            parentElement: parentElement || 'unknown',
            suggestedTemplate,
            issue,
        });
    }

    return suggestions;
}

function extractMissingElementName(message: string): string | null {
    for (const pattern of MISSING_ELEMENT_PATTERNS) {
        const m = message.match(pattern);
        if (m && m[1]) {
            return m[1];
        }
    }
    return null;
}

function extractParentElement(message: string): string {
    const m = message.match(PARENT_ELEMENT_PATTERN);
    return m ? m[1] : '';
}

/**
 * Finds the XSLT template most likely responsible for producing the
 * parent element context. Looks for templates that produce the parent
 * element but not the missing child element.
 */
function findResponsibleTemplate(
    parentElement: string,
    missingElement: string,
    templates: XsltTemplate[]
): XsltTemplate | null {
    if (!parentElement) {
        return null;
    }

    // First, look for templates that produce the parent element
    const candidates = templates.filter(t =>
        t.producedElements.includes(parentElement) &&
        !t.producedElements.includes(missingElement)
    );

    if (candidates.length > 0) {
        return candidates[0];
    }

    // Fall back: look for templates whose match pattern contains the parent element
    const matchCandidates = templates.filter(t =>
        t.matchPattern.includes(parentElement)
    );

    return matchCandidates.length > 0 ? matchCandidates[0] : null;
}
