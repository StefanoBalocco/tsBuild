#!/usr/bin/env node
export type TsBuildItem = {
    target: string;
    tsConfig: string;
    name?: string;
    prefix?: string;
    minify?: {
        files: string[];
        terser?: boolean;
        terserCompanion?: boolean;
    };
    copy?: {
        destination: string;
        files: string[];
        clean?: boolean;
    }[];
    templates?: {
        filename: string;
        destination: string;
        variables: {
            name: string;
            type: 'string' | 'mtime';
            value: string;
        }[];
    }[];
};
export default class TsBuild {
    private readonly _configDirectory;
    private readonly _targets;
    private readonly _targetsNames;
    constructor(configDirectory: string, targets: TsBuildItem[]);
    static fromConfigFile(configFile: string): Promise<TsBuild>;
    static compileTsc(configPath: string): void;
    static minifyFile(absPath: string, useTerser: boolean, useTerserCompanion: boolean): Promise<boolean>;
    build(targetNamesRequested: Set<string>): Promise<boolean>;
    static runCli(argumentsInput: string[]): Promise<number>;
}
