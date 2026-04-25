const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const DEFAULT_VERSIONS = {
  ddd: '0.8.5',
  phive: '12.0.3',
  rules: '4.3.0',
};

function resolveVersions(env = process.env) {
  return {
    ddd: env.PHIVE_DDD_VERSION || DEFAULT_VERSIONS.ddd,
    phive: env.PHIVE_VERSION || DEFAULT_VERSIONS.phive,
    rules: env.PHIVE_RULES_VERSION || DEFAULT_VERSIONS.rules,
  };
}

function getMavenRepoLocal() {
  return path.join(os.homedir(), '.m2', 'repository');
}

function getMavenCommand(javaDir) {
  if (process.platform === 'win32') {
    return path.join(javaDir, 'mvnw.cmd');
  }
  return path.join(javaDir, 'mvnw');
}

function run(command, args, options = {}) {
  cp.execFileSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    ...options,
  });
}

function buildClasspath(javaDir, versions, tempDir, offline) {
  const mvn = getMavenCommand(javaDir);
  const cpFile = path.join(tempDir, 'classpath.txt');
  const args = [
    `-Dmaven.repo.local=${getMavenRepoLocal()}`,
    'dependency:build-classpath',
    `-Dddd.version=${versions.ddd}`,
    `-Dphive.version=${versions.phive}`,
    `-Dphive.rules.version=${versions.rules}`,
    `-Dmdep.outputFile=${cpFile}`,
    '-f',
    path.join(javaDir, 'pom.xml'),
  ];
  if (offline) {
    args.splice(1, 0, '-o');
  }

  run(mvn, args, { cwd: javaDir });
  return fs.readFileSync(cpFile, 'utf8').trim();
}

function writePilotSource(tempDir) {
  const javaFile = path.join(tempDir, 'PhivePilot.java');
  fs.writeFileSync(javaFile, `
import java.io.File;
import java.util.Locale;

import javax.xml.parsers.DocumentBuilderFactory;

import org.w3c.dom.Document;

import com.helger.ddd.DocumentDetails;
import com.helger.ddd.DocumentDetailsDeterminator;
import com.helger.ddd.model.DDDSyntaxList;
import com.helger.ddd.model.DDDValueProviderList;
import com.helger.diagnostics.error.IError;
import com.helger.diver.api.coord.DVRCoordinate;
import com.helger.phive.api.execute.ValidationExecutionManager;
import com.helger.phive.api.executorset.IValidationExecutorSet;
import com.helger.phive.api.executorset.ValidationExecutorSetRegistry;
import com.helger.phive.api.result.ValidationResultList;
import com.helger.phive.api.validity.IValidityDeterminator;
import com.helger.phive.xml.source.IValidationSourceXML;
import com.helger.phive.xml.source.ValidationSourceXML;
import com.helger.phive.en16931.EN16931Validation;
import com.helger.phive.peppol.PeppolValidation;

public final class PhivePilot
{
  public static void main (final String [] aArgs) throws Exception
  {
    if (aArgs.length == 0)
      throw new IllegalArgumentException ("Expected at least one XML fixture path");

    final ValidationExecutorSetRegistry <IValidationSourceXML> aRegistry = new ValidationExecutorSetRegistry <> ();
    EN16931Validation.initEN16931 (aRegistry);
    PeppolValidation.initStandard (aRegistry);

    final DocumentDetailsDeterminator aDDD = new DocumentDetailsDeterminator (
      DDDSyntaxList.getDefaultSyntaxList (),
      DDDValueProviderList.getDefaultValueProviderList ()
    );

    for (final String sPath : aArgs)
      validateFixture (sPath, aRegistry, aDDD);
  }

  private static void validateFixture (
    final String sPath,
    final ValidationExecutorSetRegistry <IValidationSourceXML> aRegistry,
    final DocumentDetailsDeterminator aDDD
  ) throws Exception
  {
    final Document aDoc = parseXml (sPath);
    final DocumentDetails aDetails = aDDD.findDocumentDetails (aDoc.getDocumentElement ());
    final String sVESID = aDetails != null ? aDetails.getVESID () : null;
    final DVRCoordinate aCoord = sVESID != null ? DVRCoordinate.parseOrNull (sVESID) : null;
    final IValidationExecutorSet <IValidationSourceXML> aVES = aCoord != null ? aRegistry.getOfID (aCoord) : null;

    if (sVESID == null)
      throw new IllegalStateException ("DDD did not detect a VESID for " + sPath);
    if (aVES == null)
      throw new IllegalStateException ("Registry did not resolve VESID " + sVESID + " for " + sPath);

    final ValidationResultList aResults = ValidationExecutionManager.executeValidation (
      IValidityDeterminator.createDefault (),
      aVES,
      ValidationSourceXML.create (sPath, aDoc),
      Locale.ROOT
    );

    final int nIssueCount = aResults.getAllCount (x -> true);
    final boolean bHasErrors = aResults.containsAtLeastOneError ();

    System.out.println ("FILE=" + sPath);
    System.out.println ("VESID=" + sVESID);
    System.out.println ("OVERALL=" + aResults.getOverallValidity ());
    System.out.println ("ISSUES=" + nIssueCount);
    System.out.println ("HAS_ERRORS=" + bHasErrors);
    aResults.forEachFlattened (aError -> printIssue (aError));

    if (bHasErrors)
      throw new IllegalStateException ("Validation reported hard errors for " + sPath);
  }

  private static Document parseXml (final String sPath) throws Exception
  {
    final DocumentBuilderFactory aFactory = DocumentBuilderFactory.newInstance ();
    aFactory.setNamespaceAware (true);
    return aFactory.newDocumentBuilder ().parse (new File (sPath));
  }

  private static void printIssue (final IError aError)
  {
    System.out.println ("ISSUE="
                        + aError.getErrorLevel ().getID ()
                        + "|"
                        + (aError.getErrorID () != null ? aError.getErrorID () : "")
                        + "|"
                        + aError.getErrorText (Locale.ROOT));
  }
}
`, 'utf8');
  return javaFile;
}

function cleanupTempDir(tempDir) {
  if (process.env.PHIVE_PILOT_KEEP_TEMP === '1') {
    return;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runPilot(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const javaDir = options.javaDir || path.join(root, 'java');
  const versions = options.versions || resolveVersions();
  const offline = options.offline ?? process.env.PHIVE_PILOT_OFFLINE !== '0';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xml-xslt-phive-pilot-'));
  const classesDir = path.join(tempDir, 'classes');
  fs.mkdirSync(classesDir, { recursive: true });

  try {
    const classpath = buildClasspath(javaDir, versions, tempDir, offline);
    const javaFile = writePilotSource(tempDir);
    const smokeDir = path.join(root, 'validation-artifacts', 'phive-smoke');
    const invoice = path.join(smokeDir, 'invoice.xml');
    const creditNote = path.join(smokeDir, 'credit-note.xml');

    console.log(`[phive:pilot] Probing stack ddd ${versions.ddd} / phive ${versions.phive} / rules ${versions.rules}`);
    run('javac', ['--release', '17', '-cp', classpath, '-d', classesDir, javaFile], { cwd: tempDir });
    run('java', ['-cp', classesDir + path.delimiter + classpath, 'PhivePilot', invoice, creditNote], { cwd: tempDir });
    console.log('[phive:pilot] Pilot completed successfully');
  } finally {
    cleanupTempDir(tempDir);
  }
}

module.exports = {
  DEFAULT_VERSIONS,
  resolveVersions,
  runPilot,
};

if (require.main === module) {
  runPilot();
}
