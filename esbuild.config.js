const esbuild = require('esbuild');

Promise.all([
    // Extension host bundle (Node.js)
    esbuild.build({
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        bundle: true,
        platform: 'node',
        target: 'node18',
        external: ['vscode'],
        sourcemap: true,
        minify: false,
    }),

    // Webview bundle (browser sandbox — no Node.js APIs available at runtime)
    esbuild.build({
        entryPoints: ['src/webview/panel.ts'],
        outfile: 'dist/webview.js',
        bundle: true,
        platform: 'browser',
        target: 'es2020',
        sourcemap: true,
        minify: false,
    }),
]).catch(() => process.exit(1));
