import * as fs from 'fs';
import * as path from 'path';
import { detectUblDocumentFromContent } from '../validation/documentDetector';

const FIXTURES = path.join(__dirname, '../../test-fixtures');
const FAKE_ARTIFACTS = '/fake/artifacts';

describe('detectUblDocumentFromContent', () => {
    it('detects CreditNote docType from real fixture', () => {
        const content = fs.readFileSync(
            path.join(FIXTURES, '630_IV0021266_405869_SO1035613.xml'),
            'utf8',
        );
        const result = detectUblDocumentFromContent(content, FAKE_ARTIFACTS);
        expect(result).not.toBeNull();
        expect(result!.rootElement).toBe('CreditNote');
        expect(result!.docType).toBe('CreditNote');
    });

    it('includes UBL CreditNote-2 namespace', () => {
        const content = fs.readFileSync(
            path.join(FIXTURES, '630_IV0021266_405869_SO1035613.xml'),
            'utf8',
        );
        const result = detectUblDocumentFromContent(content, FAKE_ARTIFACTS);
        expect(result!.namespace).toContain('CreditNote-2');
    });

    it('builds xsdPath pointing to UBL-CreditNote-2.1.xsd under artifactsPath', () => {
        const content = fs.readFileSync(
            path.join(FIXTURES, '630_IV0021266_405869_SO1035613.xml'),
            'utf8',
        );
        const result = detectUblDocumentFromContent(content, FAKE_ARTIFACTS);
        expect(result!.xsdPath).toContain('UBL-CreditNote-2.1.xsd');
        expect(result!.xsdPath).toContain('fake'); // artifactsPath is embedded in the path
    });

    it('detects Invoice docType from inline XML', () => {
        const content = [
            '<?xml version="1.0"?>',
            '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
            '         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
            '  <cbc:ID>INV-001</cbc:ID>',
            '</Invoice>',
        ].join('\n');
        const result = detectUblDocumentFromContent(content, FAKE_ARTIFACTS);
        expect(result).not.toBeNull();
        expect(result!.docType).toBe('Invoice');
        expect(result!.xsdPath).toContain('UBL-Invoice-2.1.xsd');
    });

    it('returns null for non-UBL root element', () => {
        const result = detectUblDocumentFromContent('<root><child/></root>', FAKE_ARTIFACTS);
        expect(result).toBeNull();
    });

    it('returns null when content has no root element', () => {
        const result = detectUblDocumentFromContent('plain text', FAKE_ARTIFACTS);
        expect(result).toBeNull();
    });
});
