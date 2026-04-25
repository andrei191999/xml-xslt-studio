/**
 * PhiveRunner — subprocess entry point for phive-based UBL document validation.
 *
 * Usage (single-shot):
 *   java -cp "<jars>/*" PhiveRunner --xml /path/to/document.xml [--jars /path/to/jars/]
 *
 * Usage (daemon):
 *   java -cp "<jars>/*" PhiveRunner --daemon
 *   Reads newline-delimited JSON requests from stdin: {"xml":"/abs/path/to/file.xml"}
 *   Writes newline-delimited JSON results to stdout (same schema as single-shot stdout).
 *   Signals readiness on stderr: "[PhiveRunner] daemon ready"
 *
 * The classpath must be set by the TypeScript caller (javaRunner.ts) using the downloaded JARs
 * from the extension's globalStorageUri. For local development, place JARs in lib/phive-jars/
 * and compile with:
 *   npm run compile:phive
 *
 * Required JARs (from Maven Central):
 *   com.helger:ddd:0.8.5
 *   com.helger.phive:phive-api:12.0.3
 *   com.helger.phive:phive-xml:12.0.3
 *   com.helger.phive.rules:phive-rules-peppol:4.3.0
 *   ... plus all transitive dependencies (ph-commons, ph-diver, ph-xml, slf4j-nop, etc.)
 *
 * Output: single-line JSON to stdout. Debug/log output goes to stderr only.
 * Exit 0 on success (including DDD-not-detected). Exit 1 on fatal error.
 */

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

import org.w3c.dom.Document;
import org.w3c.dom.Element;

import com.helger.ddd.DocumentDetails;
import com.helger.ddd.DocumentDetailsDeterminator;
import com.helger.ddd.model.DDDSyntaxList;
import com.helger.ddd.model.DDDValueProviderList;

import com.helger.diver.api.coord.DVRCoordinate;

import com.helger.phive.api.execute.ValidationExecutionManager;
import com.helger.phive.api.executorset.IValidationExecutorSet;
import com.helger.phive.api.executorset.ValidationExecutorSetRegistry;
import com.helger.phive.api.result.ValidationResult;
import com.helger.phive.api.result.ValidationResultList;
import com.helger.phive.api.validity.IValidityDeterminator;

import com.helger.phive.xml.source.IValidationSourceXML;
import com.helger.phive.xml.source.ValidationSourceXML;

import com.helger.phive.en16931.EN16931Validation;
import com.helger.phive.peppol.PeppolValidation;

import com.helger.base.location.ILocation;
import com.helger.diagnostics.error.IError;
import com.helger.diagnostics.error.level.EErrorLevel;
import com.helger.diagnostics.error.level.IErrorLevel;

public class PhiveRunner
{
  public static void main (final String [] aArgs) throws Exception
  {
    // Redirect all non-JSON output from phive/SLF4J to stderr to keep stdout clean.
    // SLF4J with slf4j-nop on the classpath will already suppress framework logging.

    boolean bDaemon = false;
    String sXmlPath = null;
    String sJarsPath = null;

    for (int i = 0; i < aArgs.length; i++)
    {
      if ("--daemon".equals (aArgs[i]))
        bDaemon = true;
      else if ("--xml".equals (aArgs[i]) && i + 1 < aArgs.length)
        sXmlPath = aArgs[++i];
      else if ("--jars".equals (aArgs[i]) && i + 1 < aArgs.length)
        sJarsPath = aArgs[++i];
    }

    if (sJarsPath != null)
      System.err.println ("[PhiveRunner] jars dir: " + sJarsPath);

    // --- Daemon mode ---
    // Registry and DDD are initialised once; per-request work is just runValidation().
    if (bDaemon)
    {
      System.err.println ("[PhiveRunner] Initialising phive registry (daemon)");
      final ValidationExecutorSetRegistry <IValidationSourceXML> aRegistry = buildRegistry ();
      final DocumentDetailsDeterminator aDDD = new DocumentDetailsDeterminator (
        DDDSyntaxList.getDefaultSyntaxList (),
        DDDValueProviderList.getDefaultValueProviderList ()
      );
      System.err.println ("[PhiveRunner] daemon ready");
      System.err.flush ();

      final BufferedReader aStdin = new BufferedReader (
        new InputStreamReader (System.in, StandardCharsets.UTF_8));
      String sLine;
      while ((sLine = aStdin.readLine ()) != null)
      {
        sLine = sLine.trim ();
        if (sLine.isEmpty ())
          continue;
        final String sFile = parseXmlPathFromJson (sLine);
        if (sFile == null)
        {
          System.out.println (buildError ("Invalid daemon request: missing xml field"));
          System.out.flush ();
          continue;
        }
        try
        {
          System.out.println (runValidation (aRegistry, aDDD, sFile));
        }
        catch (final Exception ex)
        {
          System.out.println (buildError (ex.getMessage () != null ? ex.getMessage () : ex.getClass ().getSimpleName ()));
        }
        System.out.flush ();
      }
      System.exit (0);
    }

    // --- Single-shot mode ---
    if (sXmlPath == null)
    {
      printError ("Missing required argument: --xml <xmlFilePath>");
      System.exit (1);
    }

    final File aXmlFile = new File (sXmlPath);
    if (!aXmlFile.isFile ())
    {
      printError ("XML file not found: " + sXmlPath);
      System.exit (1);
    }

    try
    {
      System.err.println ("[PhiveRunner] Parsing XML: " + sXmlPath);
      System.err.println ("[PhiveRunner] Initialising phive registry");
      final ValidationExecutorSetRegistry <IValidationSourceXML> aRegistry = buildRegistry ();
      final DocumentDetailsDeterminator aDDD = new DocumentDetailsDeterminator (
        DDDSyntaxList.getDefaultSyntaxList (),
        DDDValueProviderList.getDefaultValueProviderList ()
      );
      System.out.println (runValidation (aRegistry, aDDD, sXmlPath));
      System.exit (0);
    }
    catch (final Exception ex)
    {
      System.err.println ("[PhiveRunner] Unexpected error: " + ex.getMessage ());
      ex.printStackTrace (System.err);
      printError (ex.getMessage () != null ? ex.getMessage () : ex.getClass ().getSimpleName ());
      System.exit (1);
    }
  }

  // ---------------------------------------------------------------------------
  // Registry initialization (expensive — do once per process)
  // ---------------------------------------------------------------------------

  private static ValidationExecutorSetRegistry <IValidationSourceXML> buildRegistry ()
  {
    final ValidationExecutorSetRegistry <IValidationSourceXML> aRegistry = new ValidationExecutorSetRegistry <> ();
    EN16931Validation.initEN16931 (aRegistry);
    PeppolValidation.initStandard (aRegistry);
    return aRegistry;
  }

  // ---------------------------------------------------------------------------
  // Per-request validation (fast when registry is pre-built)
  // ---------------------------------------------------------------------------

  /**
   * Validate a single XML file using the pre-built registry and DDD determinator.
   * Returns the JSON result string (same schema emitted to stdout in single-shot mode).
   */
  private static String runValidation (
    final ValidationExecutorSetRegistry <IValidationSourceXML> aRegistry,
    final DocumentDetailsDeterminator aDDD,
    final String sXmlPath
  ) throws Exception
  {
    final File aXmlFile = new File (sXmlPath);
    if (!aXmlFile.isFile ())
      return buildError ("XML file not found: " + sXmlPath);

    // Parse XML
    final Document aDoc = parseXml (aXmlFile);
    final Element aRoot = aDoc.getDocumentElement ();
    System.err.println ("[PhiveRunner] Root element: {"
                        + aRoot.getNamespaceURI () + "}" + aRoot.getLocalName ());

    // DDD detection
    System.err.println ("[PhiveRunner] Running DDD detection");
    final DocumentDetails aDetails = aDDD.findDocumentDetails (aRoot);

    if (aDetails == null || !aDetails.hasVESID ())
    {
      System.err.println ("[PhiveRunner] DDD detection returned no VESID");
      return "{\"profile\":null,\"vesid\":null,\"dddDetected\":false,\"issues\":[]}";
    }

    final String sVESID = aDetails.getVESID ();
    final String sProfileName = aDetails.getProfileName ();
    System.err.println ("[PhiveRunner] Detected VESID: " + sVESID
                        + (sProfileName != null ? " (" + sProfileName + ")" : ""));

    // Parse VESID into DVRCoordinate
    final DVRCoordinate aCoord = DVRCoordinate.parseOrNull (sVESID);
    if (aCoord == null)
      return buildError ("Could not parse VESID as DVRCoordinate: " + sVESID);

    // Look up VES in the pre-built registry
    final IValidationExecutorSet <IValidationSourceXML> aVES = aRegistry.getOfID (aCoord);
    if (aVES == null)
      return buildError ("No validation executor set registered for VESID: " + sVESID);

    // Execute validation
    System.err.println ("[PhiveRunner] Executing validation");
    final ValidationSourceXML aSource = ValidationSourceXML.create (sXmlPath, aDoc);
    final IValidityDeterminator <IValidationSourceXML> aDeterminator =
      IValidityDeterminator.createDefault ();
    final ValidationResultList aResults =
      ValidationExecutionManager.executeValidation (aDeterminator, aVES, aSource, Locale.ROOT);

    // Collect issues from all validation layers
    System.err.println ("[PhiveRunner] Collecting results");
    final List <String> aIssues = new ArrayList <> ();
    for (final ValidationResult aLayerResult : aResults)
    {
      if (aLayerResult.getValidity ().isSkipped ())
        continue;

      for (final IError aError : aLayerResult.getErrorList ())
      {
        final String sSeverity = toSeverity (aError.getErrorLevel ());
        if (sSeverity == null)
          continue;

        final String sRuleId   = aError.getErrorID ();
        final String sMessage  = aError.getErrorText (Locale.ROOT);
        final String sField    = aError.getErrorFieldName ();
        final ILocation aLoc   = aError.getErrorLocation ();
        final int nLine        = aLoc != null && aLoc.hasLineNumber ()   ? aLoc.getLineNumber ()   : 0;
        final int nColumn      = aLoc != null && aLoc.hasColumnNumber () ? aLoc.getColumnNumber () : 0;
        final String sResource = aLoc != null ? aLoc.getResourceID ()   : null;

        final StringBuilder sb = new StringBuilder ();
        sb.append ("{");
        sb.append ("\"severity\":").append (jsonStr (sSeverity)).append (",");
        sb.append ("\"ruleId\":").append (jsonStrOrNull (sRuleId)).append (",");
        sb.append ("\"message\":").append (jsonStr (sMessage != null ? sMessage : "")).append (",");
        sb.append ("\"line\":").append (nLine).append (",");
        sb.append ("\"column\":").append (nColumn).append (",");
        sb.append ("\"test\":").append (jsonStrOrNull (sField)).append (",");
        sb.append ("\"location\":").append (jsonStrOrNull (sResource));
        sb.append ("}");
        aIssues.add (sb.toString ());
      }
    }

    // Build output JSON
    final StringBuilder aOut = new StringBuilder ();
    aOut.append ("{");
    aOut.append ("\"profile\":").append (jsonStr (sVESID)).append (",");
    aOut.append ("\"vesid\":").append (jsonStr (sVESID)).append (",");
    aOut.append ("\"dddDetected\":true,");
    aOut.append ("\"issues\":[");
    for (int i = 0; i < aIssues.size (); i++)
    {
      if (i > 0)
        aOut.append (",");
      aOut.append (aIssues.get (i));
    }
    aOut.append ("]}");
    return aOut.toString ();
  }

  // ---------------------------------------------------------------------------
  // Daemon request parsing
  // ---------------------------------------------------------------------------

  /**
   * Extract the JSON-encoded "xml" field value from a daemon request line.
   * Expected format: {"xml":"<escaped-path>"}
   * Returns null if the field is absent or malformed.
   */
  private static String parseXmlPathFromJson (final String sJson)
  {
    final int nKey = sJson.indexOf ("\"xml\"");
    if (nKey < 0)
      return null;
    final int nColon = sJson.indexOf (':', nKey + 5);
    if (nColon < 0)
      return null;

    // Skip whitespace to the opening quote
    int nPos = nColon + 1;
    while (nPos < sJson.length () && sJson.charAt (nPos) != '"')
      nPos++;
    if (nPos >= sJson.length ())
      return null;
    nPos++; // skip opening quote

    final StringBuilder sb = new StringBuilder ();
    while (nPos < sJson.length ())
    {
      final char c = sJson.charAt (nPos++);
      if (c == '"')
        break; // closing quote
      if (c == '\\' && nPos < sJson.length ())
      {
        final char esc = sJson.charAt (nPos++);
        switch (esc)
        {
          case '"':  sb.append ('"');  break;
          case '\\': sb.append ('\\'); break;
          case '/':  sb.append ('/');  break;
          case 'n':  sb.append ('\n'); break;
          case 'r':  sb.append ('\r'); break;
          case 't':  sb.append ('\t'); break;
          default:   sb.append (esc);  break;
        }
      }
      else
        sb.append (c);
    }
    return sb.toString ();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private static Document parseXml (final File aFile) throws Exception
  {
    final DocumentBuilderFactory aFactory = DocumentBuilderFactory.newInstance ();
    aFactory.setNamespaceAware (true);
    final DocumentBuilder aBuilder = aFactory.newDocumentBuilder ();
    return aBuilder.parse (aFile);
  }

  private static String toSeverity (final IErrorLevel aLevel)
  {
    if (aLevel == null)
      return null;
    final int nNumeric = aLevel.getNumericLevel ();
    if (nNumeric >= EErrorLevel.ERROR.getNumericLevel ())
      return "ERROR";
    if (nNumeric >= EErrorLevel.WARN.getNumericLevel ())
      return "WARNING";
    if (nNumeric >= EErrorLevel.INFO.getNumericLevel ())
      return "INFORMATION";
    return null;
  }

  /** Emit JSON string literal, escaping special characters. Never emits null. */
  private static String jsonStr (final String s)
  {
    if (s == null)
      return "\"\"";
    final StringBuilder sb = new StringBuilder (s.length () + 4);
    sb.append ('"');
    for (final char c : s.toCharArray ())
    {
      switch (c)
      {
        case '"':  sb.append ("\\\""); break;
        case '\\': sb.append ("\\\\"); break;
        case '\n': sb.append ("\\n");  break;
        case '\r': sb.append ("\\r");  break;
        case '\t': sb.append ("\\t");  break;
        default:
          if (c < 0x20)
            sb.append (String.format ("\\u%04x", (int) c));
          else
            sb.append (c);
      }
    }
    sb.append ('"');
    return sb.toString ();
  }

  /** Emit JSON string literal or JSON null if s is null or empty. */
  private static String jsonStrOrNull (final String s)
  {
    if (s == null || s.isEmpty ())
      return "null";
    return jsonStr (s);
  }

  /** Build a JSON error envelope (profile=null, dddDetected=false, error set). */
  private static String buildError (final String sMessage)
  {
    return "{\"profile\":null,\"vesid\":null,\"dddDetected\":false,\"issues\":[],\"error\":"
           + jsonStr (sMessage) + "}";
  }

  /** Emit a JSON error envelope to stdout (single-shot mode). */
  private static void printError (final String sMessage)
  {
    System.out.println (buildError (sMessage));
  }
}
