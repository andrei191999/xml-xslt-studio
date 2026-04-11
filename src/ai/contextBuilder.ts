import * as fs from 'fs';
import { TracedIssue } from '../tracing/errorTraceMapper';
import { FixContext, FixSession, ConversationMessage } from './types';

export function buildFixContext(
    issue: TracedIssue,
    outputContent: string,
    inputXmlPath: string
): FixContext {
    const xsltFilePath = issue.xsltSourceFile!;
    const xsltContent = fs.readFileSync(xsltFilePath, 'utf8');
    const inputXmlContent = fs.readFileSync(inputXmlPath, 'utf8');

    // Extract relevant template (~50 lines around the traced XSLT line)
    const relevantTemplate = extractRelevantSection(
        xsltContent, issue.xsltSourceLine ?? 1, 50
    );

    // Extract output XML snippet (~30 lines around the error line)
    const outputXmlSnippet = extractRelevantSection(
        outputContent, issue.line, 30
    );

    return {
        error: {
            source: issue.source,
            ruleId: issue.ruleId,
            message: issue.message,
            line: issue.line,
        },
        xsltFilePath,
        xsltContent,
        relevantTemplate,
        inputXmlContent,
        outputXmlSnippet,
    };
}

function extractRelevantSection(content: string, centerLine: number, radius: number): string {
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, centerLine - 1 - radius);
    const end = Math.min(lines.length, centerLine - 1 + radius);
    const numbered = lines
        .slice(start, end)
        .map((line, i) => {
            const lineNum = start + i + 1;
            const marker = lineNum === centerLine ? ' >>>' : '    ';
            return `${marker} ${lineNum}: ${line}`;
        });
    return numbered.join('\n');
}

export function buildMessages(context: FixContext, session: FixSession): ConversationMessage[] {
    const messages: ConversationMessage[] = [];

    // System message
    messages.push({
        role: 'system',
        content: [
            'You are an XSLT repair agent for UBL documents.',
            'You have access to the input XML (source data), the XSLT mapping stylesheet, and the generated UBL output.',
            'Your job is to fix the XSLT mapping stylesheet so it produces valid UBL output. Do NOT modify the output XML — only fix the XSLT stylesheet.',
            'Return the complete modified XSLT stylesheet wrapped in <fix explanation="...">...</fix> tags.',
            'Make minimal changes to fix the specific error.',
            'Preserve all XML namespaces.',
            'Place elements in the correct UBL schema order.',
            'Use data from the input XML via XPath when possible instead of hardcoded values.',
            'Do NOT include any text outside the <fix> tags.',
        ].join(' '),
    });

    // User message with structured sections
    const sections: string[] = [];

    sections.push(`## Validation Error`);
    sections.push(`- Source: ${context.error.source}`);
    if (context.error.ruleId) {
        sections.push(`- Rule ID: ${context.error.ruleId}`);
    }
    sections.push(`- Message: ${context.error.message}`);
    sections.push(`- Output line: ${context.error.line}`);

    sections.push('');
    sections.push(`## Input XML (source data)`);
    sections.push('```xml');
    sections.push(context.inputXmlContent);
    sections.push('```');

    // Send full XSLT for files <=5000 lines, otherwise template only
    const xsltLines = context.xsltContent.split(/\r?\n/).length;
    if (xsltLines <= 5000) {
        sections.push('');
        sections.push(`## Full XSLT Stylesheet (${xsltLines} lines)`);
        sections.push('```xml');
        sections.push(context.xsltContent);
        sections.push('```');
    }

    sections.push('');
    sections.push(`## Relevant XSLT Template (around line ${context.error.line})`);
    sections.push('Lines marked with >>> indicate the traced error location:');
    sections.push('```');
    sections.push(context.relevantTemplate);
    sections.push('```');

    sections.push('');
    sections.push(`## Generated Output XML (snippet around error)`);
    sections.push('```xml');
    sections.push(context.outputXmlSnippet);
    sections.push('```');

    if (xsltLines > 5000) {
        sections.push('');
        sections.push('Note: The XSLT file is very large. Only the relevant template section is shown above. Return ONLY the modified template section, and it will be patched back into the full file.');
    }

    messages.push({ role: 'user', content: sections.join('\n') });

    // Add retry context from previous failed attempts
    for (const attempt of session.attempts) {
        // The assistant's previous fix
        messages.push({
            role: 'assistant',
            content: `<fix explanation="${attempt.proposal.explanation}">\n${attempt.proposal.proposedContent}\n</fix>`,
        });

        // Feedback about why it failed
        const feedback: string[] = ['The previous fix did not resolve the issue.'];
        if (attempt.newErrors && attempt.newErrors.length > 0) {
            feedback.push('New/remaining errors after applying that fix:');
            for (const err of attempt.newErrors) {
                feedback.push(`- ${err}`);
            }
        }
        feedback.push('Please try a different approach.');
        messages.push({ role: 'user', content: feedback.join('\n') });
    }

    return messages;
}
