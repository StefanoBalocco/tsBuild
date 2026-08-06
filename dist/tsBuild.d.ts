#!/usr/bin/env node
import { z } from 'zod';
export type TerserOptions = {
    module?: boolean;
    toplevel?: boolean;
    mangle?: false | string;
};
type TsTerserConfig = {
    enabled?: boolean;
    module?: boolean;
    toplevel?: boolean;
    mangle?: false | string;
};
declare const tsTerserConfigSchema: z.ZodType<TsTerserConfig>;
type TsTerser = z.infer<typeof tsTerserConfigSchema> | boolean;
type TsMinify = {
    files: string[];
    terser?: TsTerser;
    terserCompanion?: boolean;
};
type TsTemplateMinify = {
    terser?: TsTerser;
    terserCompanion?: boolean;
};
type TsVariable = {
    name: string;
    type: 'string' | 'mtime';
    value: string;
};
type TsTemplate = {
    filename: string;
    destination: string;
    output?: 'html' | 'esm' | 'cjs';
    variables?: TsVariable[];
    minify?: TsTemplateMinify;
};
type TsCopy = {
    destination: string;
    files: string[];
    clean?: boolean;
};
export declare const tsBuildItemSchema: z.ZodType<{
    target: string;
    tsConfig: string;
    name?: string;
    prefix?: string;
    minify?: TsMinify;
    copy?: TsCopy[];
    templates?: TsTemplate[];
}>;
export type TsBuildItem = z.infer<typeof tsBuildItemSchema>;
export default class TsBuild {
    private readonly _configDirectory;
    constructor(configDirectory: string);
    static compile(configPath: string): void;
    private static _minifySource;
    static minify(absPath: string, useTerser: boolean, useTerserCompanion: boolean, terserOptions?: TerserOptions): Promise<boolean>;
    private static _formatIssueLines;
    private static _resolveTerserConfig;
    static copy(absDestination: string, absFiles: string[], clean: boolean): Promise<void>;
    static templating(absTemplate: string, absDestination: string, variables: Record<string, string | number>): Promise<void>;
    build(buildItem: TsBuildItem): Promise<void>;
    static runCli(argumentsInput: string[]): Promise<number>;
}
export {};
