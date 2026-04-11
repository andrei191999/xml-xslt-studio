import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TempFileHandle {
    filePath: string;
    cleanup: () => void;
}

export function writeTempFile(content: string, extension: string = '.xml'): TempFileHandle {
    const tmpDir = os.tmpdir();
    const prefix = 'ubl-validator-';
    const fileName = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
    const filePath = path.join(tmpDir, fileName);
    fs.writeFileSync(filePath, content, 'utf8');
    return {
        filePath,
        cleanup: () => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch {
                // ignore cleanup errors
            }
        },
    };
}
