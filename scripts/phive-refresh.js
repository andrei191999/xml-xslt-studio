const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { runPilot, resolveVersions } = require('./phive-pilot');

const root = path.resolve(__dirname, '..');
const javaDir = path.join(root, 'java');
const libDir = path.join(root, 'lib', 'phive-jars');
const wrapper = process.platform === 'win32' ? path.join(javaDir, 'mvnw.cmd') : path.join(javaDir, 'mvnw');
const mavenRepoLocal = path.join(os.homedir(), '.m2', 'repository');

const versions = resolveVersions(process.env);

function run(command, args, options = {}) {
  cp.execFileSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
}

runPilot({ root, javaDir, versions });

fs.rmSync(libDir, { recursive: true, force: true });
fs.mkdirSync(libDir, { recursive: true });

run(wrapper, [
  `-Dmaven.repo.local=${mavenRepoLocal}`,
  'dependency:copy-dependencies',
  `-Dddd.version=${versions.ddd}`,
  `-Dphive.version=${versions.phive}`,
  `-Dphive.rules.version=${versions.rules}`,
  `-DoutputDirectory=${libDir}`,
  '-DincludeScope=compile',
  '-f',
  path.join(javaDir, 'pom.xml'),
], { cwd: javaDir });

run('npm', ['run', 'compile:phive'], { cwd: root });
