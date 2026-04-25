import * as fs from 'fs';
import * as path from 'path';
import {
    buildSoapEnvelope,
    parseSoapResponse,
    detectCustomizationId,
    resolveVesidFromProfile,
} from '../validation/helgerValidator';
import { IssueSeverity } from '../validation/types';

const FIXTURES = path.join(__dirname, '../../test-fixtures');

const MOCK_SOAP_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns:validateResponse xmlns:ns="http://peppol.helger.com/ws/documentvalidationservice/201701/">
      <ns:Result>
        <Item errorLevel="ERROR" errorID="BR-01" errorText="Invoice number is missing" errorFieldName="line: 5" test="not(cbc:ID)"/>
        <Item errorLevel="WARN" errorID="BR-W-01" errorText="Optional element missing" errorFieldName="line: 10" test="cbc:Note"/>
        <Item errorLevel="SUCCESS" errorID="" errorText="OK" errorFieldName="" test=""/>
      </ns:Result>
    </ns:validateResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

const PEPPOL_CUSTOM_ID =
    'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0';

// ---------------------------------------------------------------------------
// buildSoapEnvelope
// ---------------------------------------------------------------------------

describe('buildSoapEnvelope', () => {
    it('includes VESID attribute in the request element', () => {
        const result = buildSoapEnvelope('<foo/>', 'eu.peppol.bis3:invoice:2025.11.0');
        expect(result).toContain('VESID="eu.peppol.bis3:invoice:2025.11.0"');
    });

    it('XML-escapes < and > in document content', () => {
        const result = buildSoapEnvelope('<Invoice/>', 'eu.peppol.bis3:invoice:2025.11.0');
        expect(result).toContain('&lt;Invoice/&gt;');
        expect(result).not.toContain('<Invoice/>');
    });

    it('XML-escapes ampersands in document content', () => {
        const result = buildSoapEnvelope('a & b', 'eu.peppol.bis3:invoice:2025.11.0');
        expect(result).toContain('a &amp; b');
    });

    it('wraps escaped content inside <ns:XML> element', () => {
        const result = buildSoapEnvelope('<X/>', 'eu.peppol.bis3:invoice:2025.11.0');
        expect(result).toMatch(/<ns:XML>[\s\S]*<\/ns:XML>/);
    });
});

// ---------------------------------------------------------------------------
// parseSoapResponse
// ---------------------------------------------------------------------------

describe('parseSoapResponse', () => {
    it('maps ERROR items to IssueSeverity.Error', () => {
        const issues = parseSoapResponse(MOCK_SOAP_RESPONSE);
        const errors = issues.filter(i => i.severity === IssueSeverity.Error);
        expect(errors.length).toBe(1);
        expect(errors[0].ruleId).toBe('BR-01');
        expect(errors[0].message).toBe('Invoice number is missing');
    });

    it('maps WARN items to IssueSeverity.Warning', () => {
        const issues = parseSoapResponse(MOCK_SOAP_RESPONSE);
        const warnings = issues.filter(i => i.severity === IssueSeverity.Warning);
        expect(warnings.length).toBe(1);
        expect(warnings[0].ruleId).toBe('BR-W-01');
    });

    it('skips SUCCESS items — total count is ERROR + WARN only', () => {
        const issues = parseSoapResponse(MOCK_SOAP_RESPONSE);
        expect(issues).toHaveLength(2);
    });

    it('sets source to helger on all issues', () => {
        const issues = parseSoapResponse(MOCK_SOAP_RESPONSE);
        expect(issues.every(i => i.source === 'helger')).toBe(true);
    });

    it('parses line number from errorFieldName "line: N" pattern', () => {
        const issues = parseSoapResponse(MOCK_SOAP_RESPONSE);
        const err = issues.find(i => i.ruleId === 'BR-01');
        expect(err!.line).toBe(5);
    });

    it('returns empty array when response has no Item elements', () => {
        const empty = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body/>
</soapenv:Envelope>`;
        expect(parseSoapResponse(empty)).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// detectCustomizationId
// ---------------------------------------------------------------------------

describe('detectCustomizationId', () => {
    it('extracts CustomizationID from real CreditNote fixture', () => {
        const content = fs.readFileSync(
            path.join(FIXTURES, '630_IV0021266_405869_SO1035613.xml'),
            'utf8',
        );
        const id = detectCustomizationId(content);
        expect(id).toBe(PEPPOL_CUSTOM_ID);
    });

    it('returns undefined when CustomizationID element is absent', () => {
        expect(detectCustomizationId('<Invoice><ID>1</ID></Invoice>')).toBeUndefined();
    });

    it('returns undefined when CustomizationID is empty', () => {
        expect(detectCustomizationId('<Invoice><cbc:CustomizationID></cbc:CustomizationID></Invoice>')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// resolveVesidFromProfile
// ---------------------------------------------------------------------------

describe('resolveVesidFromProfile', () => {
    it('resolves CreditNote + latest → current VESID', () => {
        expect(resolveVesidFromProfile(PEPPOL_CUSTOM_ID, 'CreditNote', 'latest'))
            .toBe('eu.peppol.bis3:creditnote:2025.11.0');
    });

    it('resolves Invoice + latest → current VESID', () => {
        expect(resolveVesidFromProfile(PEPPOL_CUSTOM_ID, 'Invoice', 'latest'))
            .toBe('eu.peppol.bis3:invoice:2025.11.0');
    });

    it('resolves Invoice + previous → previous VESID', () => {
        expect(resolveVesidFromProfile(PEPPOL_CUSTOM_ID, 'Invoice', 'previous'))
            .toBe('eu.peppol.bis3:invoice:2025.5.0');
    });

    it('resolves with an explicit version string', () => {
        expect(resolveVesidFromProfile(PEPPOL_CUSTOM_ID, 'Invoice', '2025.11.0'))
            .toBe('eu.peppol.bis3:invoice:2025.11.0');
    });

    it('returns undefined for unknown CustomizationID', () => {
        expect(resolveVesidFromProfile('urn:unknown:profile', 'Invoice', 'latest'))
            .toBeUndefined();
    });

    it('returns undefined when docType has no catalog entry', () => {
        expect(resolveVesidFromProfile(PEPPOL_CUSTOM_ID, 'Order', 'latest'))
            .toBeUndefined();
    });
});
