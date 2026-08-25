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
type TsHashVariableType = 'hash-sha2-224' | 'hash-sha3-224' | 'hash-blake2s-256';
type TsFileVariableType = 'mtime' | TsHashVariableType;
type TsStringVariable = {
    name: string;
    type: 'string';
    value: string;
};
type TsFileVariable = {
    name: string;
    type: TsFileVariableType;
    value: string | [string, string];
};
type TsVariable = TsStringVariable | TsFileVariable;
type TsHtmlTemplate = {
    filename: string;
    destination: string;
    variables?: TsVariable[];
};
type TsJsTemplate = {
    filename: string;
    destination: string;
    output: 'esm' | 'cjs';
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
    templatesHtml?: TsHtmlTemplate[];
    templatesJs?: TsJsTemplate[];
}>;
export type TsBuildItem = z.infer<typeof tsBuildItemSchema>;
export default class TsBuild {
    private readonly _configDirectory;
    constructor(configDirectory: string);
    static compile(configPath: string): void;
    static minify(absPath: string, useTerser: boolean, useTerserCompanion: boolean, terserOptions?: TerserOptions): Promise<boolean>;
    private static _formatIssueLines;
    private static _hashFile;
    private static _formatTupleToken;
    private static _resolveTerserConfig;
    static copy(absDestination: string, absFiles: string[], clean: boolean): Promise<void>;
    static templating(absTemplate: string, absDestination: string, variables: Record<string, string | number>): Promise<void>;
    build(buildItem: TsBuildItem): Promise<void>;
    static runCli(argumentsInput: string[]): Promise<number>;
}
export {};
