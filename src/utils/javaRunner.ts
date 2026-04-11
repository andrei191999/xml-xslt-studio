import * as path from 'path';
import { execAsync, checkToolAvailable, getInstallInstructions } from './execAsync';

let javaAvailable: boolean | null = null;

export async function checkJavaAvailable(): Promise<boolean> {
    if (javaAvailable !== null) {
        return javaAvailable;
    }
    javaAvailable = await checkToolAvailable('java');
    return javaAvailable;
}

export function getBundledSaxonJarPath(extensionPath: string): string {
    return path.join(extensionPath, 'lib', 'saxon-he-10.9.jar');
}

export async function ensureJava(): Promise<void> {
    const available = await checkJavaAvailable();
    if (!available) {
        throw new Error(
            'Java is required but is not installed or not in your PATH. ' +
            getInstallInstructions('java')
        );
    }
}

export async function runSaxonTransform(
    extensionPath: string,
    sourceFile: string,
    xsltFile: string
): Promise<string> {
    await ensureJava();
    const saxonJar = getBundledSaxonJarPath(extensionPath);

    try {
        const { stdout } = await execAsync('java', [
            '-cp', saxonJar,
            'net.sf.saxon.Transform',
            `-s:${sourceFile}`,
            `-xsl:${xsltFile}`,
        ]);
        return stdout;
    } catch (error: any) {
        if (error.stdout) {
            return error.stdout;
        }
        throw new Error(`Saxon transform failed: ${error.message}`);
    }
}

export async function runXsdValidator(
    extensionPath: string,
    schemaFile: string,
    xmlFile: string
): Promise<{ stdout: string; stderr: string }> {
    await ensureJava();
    const classesDir = path.join(extensionPath, 'lib', 'classes');

    return execAsync('java', [
        '-cp', classesDir,
        'XsdValidator',
        schemaFile,
        xmlFile,
    ]);
}
