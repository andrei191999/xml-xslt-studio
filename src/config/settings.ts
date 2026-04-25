import * as vscode from 'vscode';

export interface XmlXsltConfig {
    // Transform
    transform: {
        outputDestination: 'newTab' | 'saveFile';
        defaultOutputExtension: string;
        enableTracing: boolean;
    };
    // Validation
    validation: {
        enableAutoValidate: boolean;
        enableHelger: boolean;
        helgerEndpoint: string;
        helgerVesidVersion: string;   // "latest", "previous", or explicit e.g. "2025.11.0"
        helgerTimeoutMs: number;
        enableSchematronEN16931: boolean;
        enableSchematronPeppol: boolean;
    };
    // Phive
    phive: {
        checkForUpdates: boolean;
        feedUrl: string;
        checkIntervalDays: number;
    };
    // AI
    ai: {
        provider: 'anthropic' | 'vertex' | 'openai' | 'gemini' | 'groq';
        model: string;
        vertexProject: string;
        vertexRegion: string;
        maxRetries: number;
    };
}

export function getConfig(): XmlXsltConfig {
    const cfg = vscode.workspace.getConfiguration('xmlXslt');
    return {
        transform: {
            outputDestination: cfg.get<'newTab' | 'saveFile'>('transform.outputDestination', 'newTab'),
            defaultOutputExtension: cfg.get<string>('transform.defaultOutputExtension', 'xml'),
            enableTracing: cfg.get<boolean>('transform.enableTracing', true),
        },
        validation: {
            enableAutoValidate: cfg.get<boolean>('validation.enableAutoValidate', true),
            enableHelger: cfg.get<boolean>('validation.enableHelger', false),
            helgerEndpoint: cfg.get<string>('validation.helgerEndpoint', 'https://peppol.helger.com/wsdvs'),
            helgerVesidVersion: cfg.get<string>('validation.helgerVesidVersion', 'latest'),
            helgerTimeoutMs: cfg.get<number>('validation.helgerTimeoutMs', 15000),
            enableSchematronEN16931: cfg.get<boolean>('validation.enableSchematronEN16931', true),
            enableSchematronPeppol: cfg.get<boolean>('validation.enableSchematronPeppol', true),
        },
        phive: {
            checkForUpdates: cfg.get<boolean>('phive.checkForUpdates', true),
            feedUrl: cfg.get<string>('phive.feedUrl', 'https://andrei191999.github.io/xml-xslt-studio/phive/stable.json'),
            checkIntervalDays: Math.max(1, cfg.get<number>('phive.checkIntervalDays', 7)),
        },
        ai: {
            provider: cfg.get<XmlXsltConfig['ai']['provider']>('ai.provider', 'anthropic'),
            model: cfg.get<string>('ai.model', ''),
            vertexProject: cfg.get<string>('ai.vertexProject', ''),
            vertexRegion: cfg.get<string>('ai.vertexRegion', 'us-east5'),
            maxRetries: cfg.get<number>('ai.maxRetries', 3),
        },
    };
}
