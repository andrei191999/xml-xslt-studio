import * as fs from 'fs';
import * as path from 'path';
import { ValidationIssue } from './types';
import { parseSvrlOutput, parseSvrlOutputFromContent } from './svrlParser';
import { writeTempFile } from '../utils/tempFile';
import { runSaxonTransform } from '../utils/javaRunner';

export type SchematronRuleset = 'en16931' | 'peppol';

const XSLT_FILES: Record<SchematronRuleset, string> = {
    en16931: path.join('schematron', 'en16931', 'EN16931-UBL-validation.xslt'),
    peppol: path.join('schematron', 'peppol', 'PEPPOL-EN16931-UBL.xslt'),
};

export async function validateSchematronFromContent(
    content: string,
    ruleset: SchematronRuleset,
    artifactsPath: string,
    extensionPath: string
): Promise<ValidationIssue[]> {
    const tmp = writeTempFile(content, '.xml');
    try {
        const xsltFile = path.join(artifactsPath, XSLT_FILES[ruleset]);
        if (!fs.existsSync(xsltFile)) {
            throw new Error(
                `${ruleset} XSLT not found at ${xsltFile}. ` +
                `Please reinstall the extension or run the download-artifacts script.`
            );
        }
        return await validateWithSaxonFromContent(xsltFile, tmp.filePath, content, ruleset, extensionPath);
    } finally {
        tmp.cleanup();
    }
}

export async function validateSchematron(
    filePath: string,
    ruleset: SchematronRuleset,
    artifactsPath: string,
    extensionPath: string
): Promise<ValidationIssue[]> {
    const xsltFile = path.join(artifactsPath, XSLT_FILES[ruleset]);

    if (!fs.existsSync(xsltFile)) {
        throw new Error(
            `${ruleset} XSLT not found at ${xsltFile}. ` +
            `Please reinstall the extension or run the download-artifacts script.`
        );
    }

    return validateWithSaxon(xsltFile, filePath, ruleset, extensionPath);
}

async function validateWithSaxon(
    xsltFile: string,
    filePath: string,
    ruleset: SchematronRuleset,
    extensionPath: string
): Promise<ValidationIssue[]> {
    try {
        const stdout = await runSaxonTransform(extensionPath, filePath, xsltFile);
        return parseSvrlOutput(stdout, filePath, ruleset);
    } catch (error: any) {
        if (error.stdout && error.stdout.includes('svrl:')) {
            return parseSvrlOutput(error.stdout, filePath, ruleset);
        }
        throw new Error(`Schematron validation (${ruleset}) with Saxon failed: ${error.message}`);
    }
}

async function validateWithSaxonFromContent(
    xsltFile: string,
    tempFilePath: string,
    sourceContent: string,
    ruleset: SchematronRuleset,
    extensionPath: string
): Promise<ValidationIssue[]> {
    try {
        const stdout = await runSaxonTransform(extensionPath, tempFilePath, xsltFile);
        return parseSvrlOutputFromContent(stdout, sourceContent, ruleset);
    } catch (error: any) {
        if (error.stdout && error.stdout.includes('svrl:')) {
            return parseSvrlOutputFromContent(error.stdout, sourceContent, ruleset);
        }
        throw new Error(`Schematron validation (${ruleset}) with Saxon failed: ${error.message}`);
    }
}
