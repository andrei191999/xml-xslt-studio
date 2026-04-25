import { resolveVariables } from '../commands/scenarioCommand';

describe('resolveVariables', () => {
    it('replaces ${workspaceFolder} with the workspace path', () => {
        expect(resolveVariables('${workspaceFolder}/a.xml', 'C:/proj', 'C:/proj/src'))
            .toBe('C:/proj/a.xml');
    });

    it('replaces ${fileDir} with the file directory', () => {
        expect(resolveVariables('${fileDir}/t.xsl', 'C:/proj', 'C:/proj/src'))
            .toBe('C:/proj/src/t.xsl');
    });

    it('replaces both variables in the same string', () => {
        expect(
            resolveVariables('${workspaceFolder}/out/${fileDir}/result.xml', 'C:/proj', 'C:/proj/src'),
        ).toBe('C:/proj/out/C:/proj/src/result.xml');
    });

    it('replaces multiple occurrences of ${workspaceFolder}', () => {
        expect(
            resolveVariables('${workspaceFolder}/${workspaceFolder}/doc.xml', 'C:/proj', 'C:/proj/src'),
        ).toBe('C:/proj/C:/proj/doc.xml');
    });

    it('returns the string unchanged when no variables are present', () => {
        expect(resolveVariables('/absolute/path/file.xml', 'C:/proj', 'C:/proj/src'))
            .toBe('/absolute/path/file.xml');
    });

    it('handles empty path string', () => {
        expect(resolveVariables('', 'C:/proj', 'C:/proj/src')).toBe('');
    });
});
