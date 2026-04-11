# Quick Start Guide

## Testing the Extension

1. **Open the project in VS Code**
   ```bash
   cd xslt-transformer-vscode
   code .
   ```

2. **Start the Extension Development Host**
   - Press `F5` (or go to Run > Start Debugging)
   - A new VS Code window will open with the extension loaded

3. **Test with Sample Files**
   - In the Extension Development Host window, open the `examples/sample.xml` file
   - Click the transformation button in the editor title bar (top right corner)
   - When prompted, select `examples/sample.xml` as the input XML
   - When prompted, select `examples/sample.xsl` as the XSL file
   - Choose "Show in Editor" to see the transformed HTML output

## How to Use the Button

The button is **always available** in the top-right corner of the editor:
- Look for the icon in the editor title bar
- Click it anytime to start the transformation process
- Works in any folder, with any file open

## Alternative: Command Palette

1. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
2. Type: `XSLT: Transform XML`
3. Press Enter
4. Follow the file selection prompts

## Installing the Extension Permanently

Once you're happy with the extension:

1. **Package it**
   ```bash
   npm install -g @vscode/vsce
   vsce package
   ```

2. **Install the .vsix file**
   - In VS Code, go to Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`)
   - Click the "..." menu at the top
   - Select "Install from VSIX..."
   - Choose the generated `.vsix` file

## Troubleshooting

- **Button doesn't appear**: Make sure you have an XML, XSL, or XSLT file open
- **Transformation fails**: Check that your XSL file is valid XSLT
- **No output**: Check the Developer Console (Help > Toggle Developer Tools) for errors

## What the Extension Does

1. Shows file picker for XML input
2. Shows file picker for XSL/XSLT stylesheet
3. Performs the transformation using Saxon-JS (XSLT 3.0 processor)
4. Lets you either:
   - View the result in a new editor tab
   - Save it to a file

Enjoy transforming!
