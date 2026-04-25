import { ValidationIssue, IssueSeverity } from './types';
import { resolveLineFromXPath } from '../utils/xpathLineResolver';

interface SvrlAssertion {
    id: string;
    flag: string;
    location: string;
    text: string;
}

export function parseSvrlFromContent(
    svrlXml: string,
    sourceContent: string
): ValidationIssue[] {
    const sourceLines = sourceContent.split(/\r?\n/);
    return parseSvrlWithLines(svrlXml, sourceLines);
}

function parseSvrlWithLines(
    svrlXml: string,
    sourceLines: string[]
): ValidationIssue[] {

    const issues: ValidationIssue[] = [];

    // Match failed-assert blocks
    const failedAssertPattern = /<svrl:failed-assert[\s\S]*?<\/svrl:failed-assert>/g;
    let match;
    while ((match = failedAssertPattern.exec(svrlXml)) !== null) {
        const block = match[0];
        const assertion = parseAssertionBlock(block);
        if (assertion) {
            issues.push(assertionToIssue(assertion, sourceLines));
        }
    }

    // Match successful-report blocks (warnings/info from Schematron)
    const successfulReportPattern = /<svrl:successful-report[\s\S]*?<\/svrl:successful-report>/g;
    while ((match = successfulReportPattern.exec(svrlXml)) !== null) {
        const block = match[0];
        const assertion = parseAssertionBlock(block);
        if (assertion) {
            issues.push(assertionToIssue(assertion, sourceLines));
        }
    }

    return issues;
}

function parseAssertionBlock(block: string): SvrlAssertion | null {
    const idMatch = block.match(/\bid="([^"]*?)"/);
    const flagMatch = block.match(/\bflag="([^"]*?)"/);
    const locationMatch = block.match(/\blocation="([^"]*?)"/);
    const textMatch = block.match(/<svrl:text>([\s\S]*?)<\/svrl:text>/);

    if (!textMatch) {
        return null;
    }

    return {
        id: idMatch ? idMatch[1] : '',
        flag: flagMatch ? flagMatch[1] : 'error',
        location: locationMatch ? locationMatch[1] : '',
        text: textMatch[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' '),
    };
}

function assertionToIssue(
    assertion: SvrlAssertion,
    sourceLines: string[]
): ValidationIssue {
    const line = resolveLineFromXPath(assertion.location, sourceLines);
    const severity = mapFlagToSeverity(assertion.flag);
    const prefix = assertion.id ? `[${assertion.id}] ` : '';

    return {
        line,
        column: 0,
        message: `${prefix}${assertion.text}`,
        severity,
        ruleId: assertion.id || undefined,
        source: 'local-schematron',
    };
}

function mapFlagToSeverity(flag: string): IssueSeverity {
    switch (flag.toLowerCase()) {
        case 'fatal':
        case 'error':
            return IssueSeverity.Error;
        case 'warning':
            return IssueSeverity.Warning;
        case 'information':
        case 'info':
            return IssueSeverity.Information;
        default:
            return IssueSeverity.Error;
    }
}

