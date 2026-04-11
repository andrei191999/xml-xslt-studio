import javax.xml.XMLConstants;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;
import org.xml.sax.ErrorHandler;
import org.xml.sax.SAXParseException;
import java.io.File;

/**
 * Minimal XSD validator that outputs errors in xmllint-compatible format
 * so the existing parseXmllintErrors parser works unchanged.
 *
 * Usage: java XsdValidator <schema.xsd> <document.xml>
 * Output format: file.xml:LINE: element ...: Schemas validity error : MESSAGE
 */
public class XsdValidator {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("Usage: java XsdValidator <schema.xsd> <document.xml>");
            System.exit(2);
        }

        File schemaFile = new File(args[0]);
        File xmlFile = new File(args[1]);
        final boolean[] hasErrors = {false};

        SchemaFactory factory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
        Schema schema = factory.newSchema(schemaFile);
        Validator validator = schema.newValidator();

        validator.setErrorHandler(new ErrorHandler() {
            @Override
            public void warning(SAXParseException e) {
                printError(xmlFile.getPath(), e);
            }

            @Override
            public void error(SAXParseException e) {
                hasErrors[0] = true;
                printError(xmlFile.getPath(), e);
            }

            @Override
            public void fatalError(SAXParseException e) {
                hasErrors[0] = true;
                printError(xmlFile.getPath(), e);
            }
        });

        try {
            validator.validate(new StreamSource(xmlFile));
        } catch (Exception e) {
            // Errors already reported via ErrorHandler
        }

        if (hasErrors[0]) {
            System.exit(1);
        }
    }

    private static void printError(String filePath, SAXParseException e) {
        // Match xmllint format: file.xml:LINE: element ...: Schemas validity error : MESSAGE
        System.err.println(filePath + ":" + e.getLineNumber() +
                ": element: Schemas validity error : " + e.getMessage());
    }
}
