import * as fs from 'fs';
import * as path from 'path';
import { resolveAutomation } from '../validation/paramAutomation';

describe('resolveAutomation', () => {
    // === Test 1: manual → '' ===
    it('manual mode returns empty string', async () => {
        const result = await resolveAutomation('manual', '/path/to/file.xml', '<root/>');
        expect(result).toBe('');
    });

    // === Test 2: uuid → 36-char UUID format ===
    it('uuid mode returns 36-char UUID format', async () => {
        const result = await resolveAutomation('uuid', '/path/to/file.xml', '<root/>');
        expect(result).toMatch(/^[0-9a-f-]{36}$/);
    });

    // === Test 3: two uuid calls produce different values ===
    it('two uuid calls produce different values', async () => {
        const uuid1 = await resolveAutomation('uuid', '/path/to/file.xml', '<root/>');
        const uuid2 = await resolveAutomation('uuid', '/path/to/file.xml', '<root/>');
        expect(uuid1).not.toBe(uuid2);
    });

    // === Test 4: today → YYYY-MM-DD format ===
    it('today mode returns YYYY-MM-DD format', async () => {
        const result = await resolveAutomation('today', '/path/to/file.xml', '<root/>');
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    // === Test 5: timestamp → ISO datetime ending in Z ===
    it('timestamp mode returns ISO datetime ending in Z', async () => {
        const result = await resolveAutomation('timestamp', '/path/to/file.xml', '<root/>');
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    // === Test 6: filename with '/path/to/invoice.xml' → 'invoice.xml' ===
    it('filename mode returns basename of xmlPath', async () => {
        const result = await resolveAutomation('filename', '/path/to/invoice.xml', '<root/>');
        expect(result).toBe('invoice.xml');
    });

    // === Test 7: basename with '/path/to/invoice.xml' → 'invoice' ===
    it('basename mode returns basename without extension', async () => {
        const result = await resolveAutomation('basename', '/path/to/invoice.xml', '<root/>');
        expect(result).toBe('invoice');
    });

    // === Test 8: literal string 'my-value' → 'my-value' ===
    it('literal string my-value is returned as-is', async () => {
        const result = await resolveAutomation('my-value', '/path/to/file.xml', '<root/>');
        expect(result).toBe('my-value');
    });

    // === Test 9: literal 'manual-override' (any non-keyword string) → returned as-is ===
    it('literal string manual-override (non-keyword) is returned as-is', async () => {
        const result = await resolveAutomation('manual-override', '/path/to/file.xml', '<root/>');
        expect(result).toBe('manual-override');
    });

    // === Test 10: xpath(//cbc:ID) with real fixture → returns a non-empty string ===
    it('xpath(//cbc:ID) with real fixture returns non-empty string', async () => {
        // Read the real UBL CreditNote fixture
        const fixturePath = path.join(__dirname, '../../test-fixtures/630_IV0021266_405869_SO1035613.xml');
        const xmlContent = fs.readFileSync(fixturePath, 'utf-8');

        const result = await resolveAutomation('xpath(//cbc:ID)', fixturePath, xmlContent);
        expect(result).toBeTruthy();
        expect(result.length).toBeGreaterThan(0);
    });

    // === Test 11: xpath(//cbc:InvoiceLine) with CreditNote XML → doesn't throw, returns string ===
    it('xpath(//cbc:InvoiceLine) with CreditNote fixture returns string without throwing', async () => {
        // Read the real UBL CreditNote fixture
        const fixturePath = path.join(__dirname, '../../test-fixtures/630_IV0021266_405869_SO1035613.xml');
        const xmlContent = fs.readFileSync(fixturePath, 'utf-8');

        // InvoiceLine doesn't exist in CreditNote, but xpath should handle gracefully
        const result = await resolveAutomation('xpath(//cbc:InvoiceLine)', fixturePath, xmlContent);
        expect(typeof result).toBe('string');
        // Result may be empty or non-empty depending on XPath evaluation
    });

    // === Test 12: xpath with invalid expression → '' and calls onWarning ===
    it('xpath with invalid expression returns empty string and calls onWarning', async () => {
        const warnings: string[] = [];
        const onWarning = (msg: string) => warnings.push(msg);

        const result = await resolveAutomation(
            'xpath(///invalid[[[)',
            '/path/to/file.xml',
            '<root/>',
            onWarning,
        );
        expect(result).toBe('');
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toMatch(/XPath automation failed/);
    });

    // === Test 13: xpath with malformed XML → '' and calls onWarning (never throws) ===
    it('xpath with malformed XML returns empty string and calls onWarning, never throws', async () => {
        const warnings: string[] = [];
        const onWarning = (msg: string) => warnings.push(msg);

        // This should NOT throw, even with malformed XML
        const result = await resolveAutomation(
            'xpath(//root)',
            '/path/to/file.xml',
            '<root><unclosed>',
            onWarning,
        );
        expect(result).toBe('');
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toMatch(/XPath automation failed/);
    });

    // === Test 14: xpath(//cbc:ID) with namespace-aware evaluation → returns correct value (not empty) ===
    it('xpath(//cbc:ID) with namespace-aware evaluation returns correct value', async () => {
        // Read the real UBL CreditNote fixture
        const fixturePath = path.join(__dirname, '../../test-fixtures/630_IV0021266_405869_SO1035613.xml');
        const xmlContent = fs.readFileSync(fixturePath, 'utf-8');

        const result = await resolveAutomation('xpath(//cbc:ID)', fixturePath, xmlContent);
        // The fixture has <cbc:ID>IV0021266</cbc:ID> on line 9
        expect(result).toBe('IV0021266');
    });

    // === Additional edge case tests ===

    // Test windows path with basename
    it('filename mode works with Windows-style path', async () => {
        const result = await resolveAutomation('filename', 'C:\\Users\\test\\file.xml', '<root/>');
        expect(result).toBe('file.xml');
    });

    // Test basename with Windows-style path
    it('basename mode works with Windows-style path', async () => {
        const result = await resolveAutomation('basename', 'C:\\Users\\test\\file.xml', '<root/>');
        expect(result).toBe('file');
    });

    // Test today returns consistent format
    it('today mode returns valid date that can be parsed', async () => {
        const result = await resolveAutomation('today', '/path/to/file.xml', '<root/>');
        const parsed = new Date(result);
        expect(parsed.toString()).not.toBe('Invalid Date');
    });

    // Test timestamp returns valid ISO datetime
    it('timestamp mode returns valid ISO datetime that can be parsed', async () => {
        const result = await resolveAutomation('timestamp', '/path/to/file.xml', '<root/>');
        const parsed = new Date(result);
        expect(parsed.toString()).not.toBe('Invalid Date');
    });

    // Test xpath with number result
    it('xpath returning number converts to string', async () => {
        const xmlContent = '<root><value>42</value></root>';
        const result = await resolveAutomation('xpath(count(//value))', '/path/to/file.xml', xmlContent);
        expect(typeof result).toBe('string');
        expect(result).toMatch(/^\d+(\.\d+)?$/);
    });

    // Test xpath with boolean result
    it('xpath returning boolean converts to string', async () => {
        const xmlContent = '<root><value>test</value></root>';
        const result = await resolveAutomation('xpath(boolean(//value))', '/path/to/file.xml', xmlContent);
        expect(typeof result).toBe('string');
        expect(['true', 'false']).toContain(result);
    });

    // Test xpath with string result (non-node)
    it('xpath returning string result returns the string', async () => {
        const xmlContent = '<root><value>hello</value></root>';
        const result = await resolveAutomation('xpath(substring(//value, 1, 3))', '/path/to/file.xml', xmlContent);
        expect(result).toBe('hel');
    });

    // Test empty string as automation mode
    it('empty string is returned as literal', async () => {
        const result = await resolveAutomation('', '/path/to/file.xml', '<root/>');
        expect(result).toBe('');
    });

    // Test case sensitivity of keywords
    it('UUID (uppercase) is treated as literal, not keyword', async () => {
        const result = await resolveAutomation('UUID', '/path/to/file.xml', '<root/>');
        expect(result).toBe('UUID');
    });

    // Test XPATH (uppercase) is treated as literal, not keyword
    it('XPATH (uppercase) is treated as literal, not keyword', async () => {
        const result = await resolveAutomation('XPATH(//test)', '/path/to/file.xml', '<root/>');
        expect(result).toBe('XPATH(//test)');
    });

    // Test onWarning not called on successful xpath
    it('onWarning is not called on successful xpath evaluation', async () => {
        const warnings: string[] = [];
        const onWarning = (msg: string) => warnings.push(msg);

        const xmlContent = '<root><value>test</value></root>';
        await resolveAutomation('xpath(//value)', '/path/to/file.xml', xmlContent, onWarning);
        expect(warnings).toHaveLength(0);
    });

    // Test onWarning not called for non-xpath modes
    it('onWarning is not called for non-xpath modes', async () => {
        const warnings: string[] = [];
        const onWarning = (msg: string) => warnings.push(msg);

        await resolveAutomation('uuid', '/path/to/file.xml', '<root/>', onWarning);
        expect(warnings).toHaveLength(0);
    });

    // Test xpath with empty node result
    it('xpath with no matching nodes returns empty string', async () => {
        const xmlContent = '<root><value>test</value></root>';
        const result = await resolveAutomation('xpath(//nonexistent)', '/path/to/file.xml', xmlContent);
        expect(result).toBe('');
    });
});
