@echo off
setlocal enabledelayedexpansion

set "MAVEN_PROJECTBASEDIR=%~dp0"
if "%MAVEN_PROJECTBASEDIR:~-1%"=="\" set "MAVEN_PROJECTBASEDIR=%MAVEN_PROJECTBASEDIR:~0,-1%"

set "WRAPPER_PROPERTIES=%MAVEN_PROJECTBASEDIR%\.mvn\wrapper\maven-wrapper.properties"

for /f "usebackq tokens=1,* delims==" %%a in ("%WRAPPER_PROPERTIES%") do (
    if "%%a"=="distributionUrl" set "DISTRIBUTION_URL=%%b"
)

set "MAVEN_USER_HOME=%USERPROFILE%\.m2"
set "MAVEN_WRAPPER_HOME=%MAVEN_USER_HOME%\wrapper"

for %%f in ("%DISTRIBUTION_URL%") do set "DIST_FILE=%%~nxf"
set "DIST_NAME=%DIST_FILE:.zip=%"
set "DIST_DIR=%MAVEN_WRAPPER_HOME%\dists\%DIST_NAME%"

if not exist "%DIST_DIR%\%DIST_NAME%\bin\mvn.cmd" (
    if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"
    echo [mvnw] Downloading Maven 3.9.9 from Maven Central...
    powershell -NoProfile -Command ^
        "Invoke-WebRequest -Uri '%DISTRIBUTION_URL%' -OutFile '%DIST_DIR%\%DIST_FILE%' -UseBasicParsing"
    powershell -NoProfile -Command ^
        "Expand-Archive -Path '%DIST_DIR%\%DIST_FILE%' -DestinationPath '%DIST_DIR%' -Force"
    del /q "%DIST_DIR%\%DIST_FILE%"
    echo [mvnw] Maven downloaded to %DIST_DIR%
)

for /d %%d in ("%DIST_DIR%\apache-maven-*") do set "MAVEN_HOME=%%d"

if not defined MAVEN_HOME (
    echo [mvnw] ERROR: Could not locate Maven installation in %DIST_DIR% >&2
    exit /b 1
)

"%MAVEN_HOME%\bin\mvn.cmd" %*
endlocal
