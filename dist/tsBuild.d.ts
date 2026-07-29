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
    constructor(configDirectory: string);
    static compile(configPath: string): void;
    static minify(absPath: string, useTerser: boolean, useTerserCompanion: boolean): Promise<boolean>;
    static copy(absDestination: string, absFiles: string[], clean: boolean): Promise<void>;
    static templating(absTemplate: string, absDestination: string, variables: Record<string, string | number>): Promise<void>;
    build(buildItem: TsBuildItem): Promise<void>;
    static runCli(argumentsInput: string[]): Promise<number>;
}
