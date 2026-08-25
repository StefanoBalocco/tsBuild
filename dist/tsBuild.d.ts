#!/usr/bin/env node
import { z } from 'zod';
export type TerserOptions = {
    module?: boolean;
    toplevel?: boolean;
    mangle?: false | string;
};
export declare const tsBuildItemSchema: z.ZodType<{
    target: string;
    tsConfig: string;
    name?: string;
    prefix?: string;
    minify?: {
        files: string[];
        terser?: {
            enabled?: boolean;
            module?: boolean;
            toplevel?: boolean;
            mangle?: false | string;
        } | boolean;
        terserCompanion?: boolean;
    };
    copy?: {
        destination: string;
        files: string[];
        clean?: boolean;
    }[];
    templatesHtml?: {
        filename: string;
        destination: string;
        variables?: {
            name: string;
            type: string;
            value: string | [string, string];
        }[];
    }[];
    templatesJs?: {
        filename: string;
        destination: string;
        output: 'esm' | 'cjs';
    }[];
}>;
export type TsBuildItem = z.infer<typeof tsBuildItemSchema>;
export default class TsBuild {
    private readonly _configDirectory;
    constructor(configDirectory: string);
    private static readonly _hashAlgorithmMap;
    static compile(configPath: string): void;
    static minify(absPath: string, useTerser: boolean, useTerserCompanion: boolean, terserOptions?: TerserOptions): Promise<boolean>;
    private static _formatIssueLines;
    private static _formatTupleToken;
    static copy(absDestination: string, absFiles: string[], clean: boolean): Promise<void>;
    static templating(absTemplate: string, absDestination: string, variables: Record<string, string | number>): Promise<void>;
    build(buildItem: TsBuildItem): Promise<void>;
    static runCli(argumentsInput: string[]): Promise<number>;
}
