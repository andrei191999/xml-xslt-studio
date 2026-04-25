import * as fs from 'fs';
import * as path from 'path';
import { parseSvrlFromContent } from '../validation/svrlParser';
import { IssueSeverity } from '../validation/types';

const FIXTURES = path.join(__dirname, '../../test-fixtures');

describe('parseSvrlFromContent', () => {
    it('parses fatal flag as IssueSeverity.Error', () => {
        const svrl = fs.readFileSync(path.join(FIXTURES, 'invoice_svrl.xml'), 'utf8');
        const issues = parseSvrlFromContent(svrl, '');
        const errors = issues.filter(i => i.severity === IssueSeverity.Error);
        expect(errors.length).toBeGreaterThan(0);
    });

    it('parses warning flag as IssueSeverity.Warning', () => {
        const svrl = fs.readFileSync(path.join(FIXTURES, 'invoice_svrl.xml'), 'utf8');
        const issues = parseSvrlFromContent(svrl, '');
        const warnings = issues.filter(i => i.severity === IssueSeverity.Warning);
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0].severity).toBe(IssueSeverity.Warning);
    });

    it('extracts ruleId from the id attribute', () => {
        const svrl = fs.readFileSync(path.join(FIXTURES, 'invoice_svrl.xml'), 'utf8');
        const issues = parseSvrlFromContent(svrl, '');
        const rule = issues.find(i => i.ruleId === 'PEPPOL-EN16931-R010');
        expect(rule).toBeDefined();
        expect(rule!.ruleId).toBe('PEPPOL-EN16931-R010');
    });

    it('returns undefined ruleId when id attribute is absent', () => {
        const svrl = `<svrl:schematron-output xmlns:svrl="http://purl.oclc.org/dsdl/svrl">
  <svrl:failed-assert flag="fatal" location="/">
    <svrl:text>Some rule fired</svrl:text>
  </svrl:failed-assert>
</svrl:schematron-output>`;
        const issues = parseSvrlFromContent(svrl, '');
        expect(issues).toHaveLength(1);
        expect(issues[0].ruleId).toBeUndefined();
    });

    it('returns empty array for SVRL with no assertions (valid creditnote)', () => {
        const svrl = fs.readFileSync(path.join(FIXTURES, 'creditnote_svrl.xml'), 'utf8');
        const issues = parseSvrlFromContent(svrl, '');
        expect(issues).toHaveLength(0);
    });

    it('sets source to local-schematron on all issues', () => {
        const svrl = fs.readFileSync(path.join(FIXTURES, 'invoice_svrl.xml'), 'utf8');
        const issues = parseSvrlFromContent(svrl, '');
        expect(issues.every(i => i.source === 'local-schematron')).toBe(true);
    });

    it('includes rule id prefix in message', () => {
        const svrl = fs.readFileSync(path.join(FIXTURES, 'invoice_svrl.xml'), 'utf8');
        const issues = parseSvrlFromContent(svrl, '');
        const rule = issues.find(i => i.ruleId === 'PEPPOL-EN16931-R010');
        expect(rule!.message).toContain('PEPPOL-EN16931-R010');
    });
});
